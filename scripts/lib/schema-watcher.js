// Detecta mudança de schema (migrations Flyway, mapeamento JPA, persistence.xml) no
// diff de um ticket e gera a checklist de migração que o watcher põe no context.md da
// task (bloco "## ⚠️ Schema Migration Checklist").
//
// Só ALERTA — nunca bloqueia o ciclo. Funções puras (texto in, texto out); quem lê git
// e grava arquivo é o watcher (stampSchemaChecklist em readmine-watcher.js).
//
// Classificação de risco (a mais alta vence no riskLevel geral):
//   ADD    -> low     CREATE TABLE/INDEX, ALTER TABLE … ADD, INSERT, @Column novo
//   ALTER  -> medium  ALTER COLUMN/MODIFY, UPDATE/DELETE de dados, @Column alterado
//   RENAME -> high    RENAME / sp_rename / CHANGE COLUMN, @Column(name) trocado
//   DROP   -> high    DROP, TRUNCATE, @Column/@Entity removido
// RENAME é high (não medium): com deploy em rolling/homologação compartilhada, a
// versão antiga da aplicação quebra no instante em que a coluna muda de nome.
// Migration Flyway já existente editada ou removida também é high — o checksum muda e
// o `flyway validate` do próximo deploy falha.
//
// Sem Flyway no projeto não há arquivo V*__*.sql no diff e só a parte JPA age.

const fs = require('fs');
const path = require('path');

const RISK_BY_TYPE = { ADD: 'low', ALTER: 'medium', RENAME: 'high', DROP: 'high' };
const RISK_ORDER = ['low', 'medium', 'high'];

const FLYWAY_RE = /(^|\/)V\d+(?:[._]\d+)*__[^/]+\.sql$/i;
const PERSISTENCE_RE = /(^|\/)persistence\.xml$/i;
const JPA_ANNOTATION_RE = /@(Entity|Table|Column|JoinColumn|JoinTable)\b(\s*\([^)]*\)?)?/;

const TEMPLATE_PATH = path.join(__dirname, '..', '..', 'templates', 'migration-checklist.md');
const CONTEXT_BEGIN = '<!-- schema-watcher:inicio';
const CONTEXT_END = '<!-- schema-watcher:fim -->';

function normalize(file) {
    return String(file || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

function fileKind(file) {
    if (FLYWAY_RE.test(file)) return 'flyway';
    if (PERSISTENCE_RE.test(file)) return 'persistence';
    if (/\.java$/i.test(file)) return 'jpa';
    return null;
}

// Arquivos cujo diff vale a pena coletar (o watcher usa pra não puxar o diff inteiro).
function isCandidate(file) {
    return fileKind(normalize(file)) !== null;
}

// Unified diff -> Map(path -> { added, removed, isNew, isDeleted, contexts }).
function parseDiff(diffContent) {
    const files = new Map();
    let cur = null;
    const open = (p) => {
        const key = normalize(p);
        if (!files.has(key)) files.set(key, { added: [], removed: [], isNew: false, isDeleted: false, contexts: [] });
        return files.get(key);
    };
    let pendingNew = false, pendingDeleted = false, oldPath = null;
    for (const line of String(diffContent || '').split('\n')) {
        const header = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
        if (header) {
            cur = open(header[2]);
            pendingNew = pendingDeleted = false;
            oldPath = header[1];
            continue;
        }
        if (/^new file mode/.test(line)) { pendingNew = true; if (cur) cur.isNew = true; continue; }
        if (/^deleted file mode/.test(line)) { pendingDeleted = true; if (cur) cur.isDeleted = true; continue; }
        if (line.startsWith('--- ')) { oldPath = line.slice(4).replace(/^a\//, ''); continue; }
        if (line.startsWith('+++ ')) {
            const target = line.slice(4);
            if (target === '/dev/null') {
                cur = open(oldPath);
                cur.isDeleted = true;
            } else {
                cur = open(target.replace(/^b\//, ''));
                if (oldPath === '/dev/null' || pendingNew) cur.isNew = true;
                if (pendingDeleted) cur.isDeleted = true;
            }
            continue;
        }
        if (!cur) continue;
        const hunk = line.match(/^@@[^@]*@@\s*(.*)$/);
        if (hunk) { if (hunk[1]) cur.contexts.push(hunk[1]); continue; }
        if (line.startsWith('+')) cur.added.push(line.slice(1));
        else if (line.startsWith('-')) cur.removed.push(line.slice(1));
    }
    return files;
}

function makeChange(file, kind, type, table, detail, risk = RISK_BY_TYPE[type]) {
    return { file, kind, type, risk, table: table || null, detail };
}

// --- SQL (Flyway) ------------------------------------------------------------------

function stripSqlComments(sql) {
    return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

function cleanIdent(id) {
    return id.replace(/[`"[\]]/g, '');
}

function sqlTable(stmt) {
    const m = stmt.match(/\b(?:TABLE(?:\s+IF\s+(?:NOT\s+)?EXISTS)?|INTO|UPDATE|FROM|ON)\s+([`"[\]\w.]+)/i)
        || stmt.match(/\bsp_rename\s+'([\w.]+?)(?:\.\w+)?'/i);
    return m ? cleanIdent(m[1]) : null;
}

function classifySqlStatement(stmt) {
    const s = stmt.toUpperCase();
    if (/\bDROP\b/.test(s) || /^TRUNCATE\b/.test(s)) return 'DROP';
    if (/\bRENAME\b/.test(s) || /\bSP_RENAME\b/.test(s) || /\bCHANGE\s+(COLUMN\s+)?\w+\s+\w+/.test(s)) return 'RENAME';
    if (/^CREATE\b/.test(s) || /^INSERT\b/.test(s)) return 'ADD';
    if (/^ALTER\s+TABLE\b/.test(s) && /\bADD\b/.test(s) && !/\b(ALTER|MODIFY)\s+COLUMN\b/.test(s)) return 'ADD';
    return 'ALTER';
}

function sqlChanges(file, entry) {
    if (!entry) {
        return [makeChange(file, 'flyway', 'ALTER', null,
            'migration Flyway alterada (conteúdo não disponível no diff — revise o arquivo)')];
    }
    if (entry.isDeleted) {
        return [makeChange(file, 'flyway', 'DROP', null,
            'migration Flyway removida — bancos que já a aplicaram ficam divergentes do histórico')];
    }
    const out = [];
    if (!entry.isNew && entry.removed.some(l => l.trim())) {
        out.push(makeChange(file, 'flyway', 'ALTER', null,
            'migration Flyway já existente foi editada — checksum muda e `flyway validate` falha em quem já aplicou; crie uma V nova', 'high'));
    }
    const statements = stripSqlComments(entry.added.join('\n'))
        .split(';').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
    for (const stmt of statements) {
        const type = classifySqlStatement(stmt);
        out.push(makeChange(file, 'flyway', type, sqlTable(stmt), stmt.length > 160 ? `${stmt.slice(0, 157)}…` : stmt));
    }
    return out;
}

// --- JPA ---------------------------------------------------------------------------

function annotationLines(lines) {
    return lines
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'))
        .map(l => {
            const m = l.match(JPA_ANNOTATION_RE);
            if (!m) return null;
            const name = l.match(/\bname\s*=\s*"([^"]+)"/);
            return { annotation: m[1], name: name ? name[1] : null, text: l };
        })
        .filter(Boolean);
}

function jpaTable(file, entry) {
    const lines = [...entry.added, ...entry.removed];
    for (const l of lines) {
        const m = l.match(/@Table\s*\([^)]*\bname\s*=\s*"([^"]+)"/) || l.match(/@Entity\s*\([^)]*\bname\s*=\s*"([^"]+)"/);
        if (m) return m[1];
    }
    const cls = entry.contexts.map(c => c.match(/\bclass\s+(\w+)/)).find(Boolean);
    return `${cls ? cls[1] : path.basename(file, '.java')} (entidade)`;
}

function jpaChanges(file, entry) {
    if (!entry) return [];
    const added = annotationLines(entry.added);
    const removed = annotationLines(entry.removed);
    if (!added.length && !removed.length) return [];
    const table = jpaTable(file, entry);
    const out = [];
    const pool = [...added];
    for (const r of removed) {
        const i = pool.findIndex(a => a.annotation === r.annotation);
        if (i === -1) {
            out.push(makeChange(file, 'jpa', 'DROP', table, `removido: ${r.text}`));
            continue;
        }
        const [a] = pool.splice(i, 1);
        const renamed = r.name && a.name && r.name !== a.name;
        out.push(makeChange(file, 'jpa', renamed ? 'RENAME' : 'ALTER', table,
            renamed ? `@${a.annotation} renomeado: "${r.name}" -> "${a.name}"` : `alterado: ${r.text} -> ${a.text}`));
    }
    for (const a of pool) out.push(makeChange(file, 'jpa', 'ADD', table, `adicionado: ${a.text}`));
    return out;
}

// --- persistence.xml ---------------------------------------------------------------

function persistenceChanges(file, entry) {
    if (entry && entry.added.some(l => /hbm2ddl\.auto|schema-generation\.database\.action/.test(l) && /"(create|create-drop|drop-and-create|drop)"/.test(l))) {
        return [makeChange(file, 'persistence', 'DROP', null,
            'geração de schema configurada para recriar/dropar o banco (hbm2ddl.auto / schema-generation)')];
    }
    return [makeChange(file, 'persistence', 'ALTER', null, 'persistence.xml alterado — revise unidade de persistência e geração de schema')];
}

// --- API ---------------------------------------------------------------------------

function maxRisk(changes) {
    return changes.reduce((acc, c) => (RISK_ORDER.indexOf(c.risk) > RISK_ORDER.indexOf(acc) ? c.risk : acc), 'low');
}

/**
 * @param {string[]} changedFiles caminhos alterados (relativos à raiz do repo)
 * @param {string} diffContent unified diff (git diff) dos arquivos; untracked podem vir como "new file"
 * @returns {{detected: boolean, changes: SchemaChange[], riskLevel: 'low'|'medium'|'high'}}
 */
function detectSchemaChanges(changedFiles, diffContent) {
    const diff = parseDiff(diffContent);
    const files = [...new Set([...(changedFiles || []).map(normalize).filter(Boolean), ...diff.keys()])];
    const changes = [];
    for (const file of files) {
        const kind = fileKind(file);
        const entry = diff.get(file);
        if (kind === 'flyway') changes.push(...sqlChanges(file, entry));
        else if (kind === 'persistence') changes.push(...persistenceChanges(file, entry));
        else if (kind === 'jpa') changes.push(...jpaChanges(file, entry));
    }
    return { detected: changes.length > 0, changes, riskLevel: maxRisk(changes) };
}

function affectedTables(changes) {
    return [...new Set(changes.map(c => c.table).filter(Boolean))].sort();
}

function rollbackHint(c) {
    if (c.kind === 'flyway' && c.type === 'ADD') {
        const s = c.detail.toUpperCase();
        if (/^CREATE\s+TABLE/.test(s)) return `\`DROP TABLE ${c.table};\``;
        if (/^CREATE\s+(UNIQUE\s+)?INDEX/.test(s)) return '`DROP INDEX …;` (nome do índice criado)';
        if (/^ALTER\s+TABLE/.test(s)) return `\`ALTER TABLE ${c.table} DROP COLUMN …;\` (coluna adicionada)`;
        if (/^INSERT/.test(s)) return `\`DELETE FROM ${c.table} WHERE …;\` (linhas inseridas)`;
    }
    if (c.type === 'DROP') return 'irreversível sem backup — faça dump da tabela/coluna antes e documente o restore';
    if (c.type === 'RENAME') return 'renomear de volta (nome original) — e confirmar que nenhuma versão antiga da aplicação segue rodando';
    return 'escrever o inverso manualmente (valor/tipo anterior)';
}

const RISK_LABEL = { low: '🟢 low', medium: '🟡 medium', high: '🔴 high' };

function formatChangesList(changes) {
    return changes.map(c =>
        `- **${c.type}** (${RISK_LABEL[c.risk]}) \`${c.file}\`${c.table ? ` — tabela \`${c.table}\`` : ''}: ${c.detail}`).join('\n');
}

function formatRollbackHints(changes) {
    return changes.map(c => `- \`${c.file}\` ${c.type}${c.table ? ` ${c.table}` : ''}: ${rollbackHint(c)}`).join('\n');
}

function loadTemplate(templatePath = TEMPLATE_PATH) {
    return fs.readFileSync(templatePath, 'utf8');
}

// Preenche o template. Placeholders: {{CHANGES_LIST}}, {{RISK_LEVEL}},
// {{AFFECTED_TABLES}}, {{ROLLBACK_HINTS}}.
function renderMigrationChecklist(result, { template = loadTemplate() } = {}) {
    const tables = affectedTables(result.changes);
    const values = {
        CHANGES_LIST: formatChangesList(result.changes),
        RISK_LEVEL: RISK_LABEL[result.riskLevel],
        AFFECTED_TABLES: tables.length ? tables.map(t => `\`${t}\``).join(', ') : '(não identificadas automaticamente — revise o diff)',
        ROLLBACK_HINTS: formatRollbackHints(result.changes),
    };
    return template.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in values ? values[k] : m));
}

// Assinatura do que foi detectado: enquanto não muda, o bloco no context.md fica
// intocado (preserva checkboxes marcados por humano/agente).
function signatureOf(result) {
    const key = JSON.stringify(result.changes.map(c => [c.file, c.type, c.risk, c.table, c.detail]));
    return require('crypto').createHash('sha1').update(key).digest('hex').slice(0, 12);
}

function formatContextBlock(result, opts) {
    return [
        `${CONTEXT_BEGIN} sig=${signatureOf(result)} -->`,
        renderMigrationChecklist(result, opts).trim(),
        CONTEXT_END,
    ].join('\n');
}

// Insere (append no fim), substitui ou — sem mudança de schema — remove o bloco da
// checklist num texto de context.md. Retorna o texto novo (igual se nada mudou).
function upsertContextChecklist(existing, result, opts) {
    const text = existing || '';
    const begin = text.indexOf(CONTEXT_BEGIN);
    const end = begin === -1 ? -1 : text.indexOf(CONTEXT_END, begin);
    const hasBlock = begin !== -1 && end !== -1;

    if (hasBlock) {
        const before = text.slice(0, begin);
        const after = text.slice(end + CONTEXT_END.length);
        if (!result.detected) return (before.replace(/\n+$/, '\n') + after.replace(/^\n+/, '')).replace(/^\n+/, '');
        const sig = text.slice(begin, text.indexOf('-->', begin)).match(/sig=(\w+)/);
        if (sig && sig[1] === signatureOf(result)) return text;
        return before + formatContextBlock(result, opts) + after;
    }
    if (!result.detected) return text;
    const block = formatContextBlock(result, opts);
    return text ? `${text.replace(/\n*$/, '')}\n\n${block}\n` : `${block}\n`;
}

// Lê de volta o bloco da checklist de um context.md (o dashboard usa pra renderizar).
// null se não houver bloco. signature = sig gravada no marcador de abertura.
function extractContextChecklist(text) {
    const src = text || '';
    const begin = src.indexOf(CONTEXT_BEGIN);
    if (begin === -1) return null;
    const openEnd = src.indexOf('-->', begin);
    const end = src.indexOf(CONTEXT_END, begin);
    if (openEnd === -1 || end === -1 || end < openEnd) return null;
    const sig = src.slice(begin, openEnd).match(/sig=(\w+)/);
    return { markdown: src.slice(openEnd + 3, end).trim(), signature: sig ? sig[1] : null };
}

module.exports = {
    detectSchemaChanges, extractContextChecklist, isCandidate, parseDiff, classifySqlStatement,
    renderMigrationChecklist, upsertContextChecklist, affectedTables, signatureOf,
    TEMPLATE_PATH, CONTEXT_BEGIN, CONTEXT_END, RISK_BY_TYPE,
};
