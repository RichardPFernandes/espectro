// Contexto de entrada pré-montado pelo watcher para os nós plan e review.
//
// Por quê: o custo de um ciclo se concentrava em Plan (~8,8 mi tokens de entrada) e
// Review (~9,9 mi). A entrada de uma sessão `claude -p` é cumulativa — cada turno
// reenvia tudo o que já foi lido —, então um arquivo inteiro lido no começo da sessão
// é pago de novo em cada turno seguinte. Aqui o watcher entrega no prompt só o mínimo
// suficiente (descrição truncada, nomes de arquivos, diff real, pré-checagens já
// rodadas) e os comandos .claude/commands/{plan,review}.md mandam o agente partir disso
// em vez de reler arquivos completos. Comprime a ENTRADA, não o raciocínio.
//
// Todo texto que sai daqui vai pro argv do `claude -p` (visível em `ps`) e pro
// transcript: passa pelo sanitize de sanitize-log.js antes (BITBUCKET_API_TOKEN,
// REDMINE_API_KEY e qualquer *_TOKEN/*_API_KEY/*_SECRET/*_PASSWORD do env viram
// [REDACTED]). A checagem de secret do item 1 do review reporta só ARQUIVO, nunca valor.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TRUNCATION_MARK = '\n[... truncado para reduzir tokens ...]';
const TICKET_DESC_MAX_CHARS = 3000;
// ~1500 tokens (≈ 4 chars/token em português).
const CONTEXT_MD_MAX_CHARS = 6000;
// Teto do diff no prompt do review. Acima disso vai a lista dos arquivos restantes e o
// agente lê `git diff HEAD -- <arquivo>` só do que precisar. Mantém o prompt também
// longe do limite de 128 KB por argumento do Linux (MAX_ARG_STRLEN).
const REVIEW_DIFF_MAX_CHARS = 60000;
const STRUCTURE_MAX_CHARS = 4000;
const MAX_TREE_NODES = 40;
const MAX_SIBLING_TREE_NODES = 12;
const MAX_KEYWORD_PATHS = 30;
const MAX_CITED_FILES = 10;
// Arquivo novo (untracked) maior que isto entra no diff só pelo nome.
const MAX_UNTRACKED_FILE_BYTES = 200 * 1024;

function truncate(str, maxChars) {
    str = str == null ? '' : String(str);
    if (str.length <= maxChars) return str;
    return str.slice(0, maxChars) + TRUNCATION_MARK;
}

function git(cwd, args) {
    return execFileSync('git', args, {
        cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024,
    });
}

function gitLines(cwd, args) {
    try { return git(cwd, args).split('\n').map(l => l.trim()).filter(Boolean); } catch { return []; }
}

// memory/ é local (untracked desde 2026-09-23), mas branches antigas ainda a versionam —
// sem isto, state.json/context.md que o próprio agente escreve apareceriam no diff do
// review (e o item 2 os acusaria como fora de escopo) e poluiriam a árvore do plan.
const EXCLUDE_PATHSPEC = ['--', '.', ':(exclude)memory', ':(exclude).claude'];

function lsFiles(cwd, extra = []) {
    try {
        return git(cwd, ['ls-files', '-z', ...extra, ...EXCLUDE_PATHSPEC]).split('\0').filter(Boolean);
    } catch { return []; }
}

function readOrEmpty(p) {
    try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

// ---------------------------------------------------------------------------------
// Estrutura do projeto: nomes de diretórios, não conteúdo. Listar todos os arquivos
// (211 KB no app-back) ou todos os diretórios (56 KB) custaria mais que ler os
// arquivos que o plan quer evitar — então a árvore é comprimida: começa nos
// diretórios de topo e vai expandindo o nó com mais arquivos enquanto couber em
// maxNodes; cadeias de um filho só (src/main/java/br/com/...) colapsam de graça.
function buildTree(files) {
    const root = { name: '', children: new Map(), files: 0 };
    for (const f of files) {
        const parts = f.split('/');
        parts.pop();
        let node = root;
        node.files++;
        for (const part of parts) {
            if (!node.children.has(part)) node.children.set(part, { name: part, children: new Map(), files: 0 });
            node = node.children.get(part);
            node.files++;
        }
    }
    return root;
}

function collapse(node, prefix) {
    let label = prefix ? `${prefix}/${node.name}` : node.name;
    while (node.children.size === 1) {
        const [only] = node.children.values();
        // Só colapsa se todos os arquivos do nó estão no filho (nenhum arquivo solto).
        if (only.files !== node.files) break;
        node = only;
        label = `${label}/${node.name}`;
    }
    return { label, node };
}

function compressedTree(files, maxNodes = MAX_TREE_NODES) {
    if (!files.length) return [];
    const root = buildTree(files);
    const rootFiles = root.files - [...root.children.values()].reduce((s, c) => s + c.files, 0);
    let frontier = [...root.children.values()].map(c => collapse(c, ''));
    for (;;) {
        const expandable = frontier
            .filter(e => e.node.children.size > 0)
            .sort((a, b) => b.node.files - a.node.files);
        let expanded = false;
        for (const e of expandable) {
            const kids = [...e.node.children.values()];
            const direct = e.node.files - kids.reduce((s, c) => s + c.files, 0);
            const added = kids.length - 1 + (direct > 0 ? 1 : 0);
            if (frontier.length + added > maxNodes) continue;
            frontier = frontier.filter(x => x !== e);
            if (direct > 0) frontier.push({ label: `${e.label}/*`, node: { children: new Map(), files: direct }, leaf: true });
            for (const k of kids) frontier.push(collapse(k, e.label));
            expanded = true;
            break;
        }
        if (!expanded) break;
    }
    const lines = frontier
        .sort((a, b) => a.label.localeCompare(b.label))
        .map(e => `${e.label}${e.leaf || e.node.children.size === 0 ? '' : '/…'} (${e.node.files})`);
    if (rootFiles > 0) lines.unshift(`./* (${rootFiles})`);
    return lines;
}

// Termos do ticket (sem acento, minúsculos, ≥ 5 letras, sem stopwords) — casados contra
// o caminho dos arquivos pra sugerir onde olhar, sem abrir nada.
const STOPWORDS = new Set(`quando porque sobre entre depois antes ainda assim dessa desse desta deste essas esses estas estes
    nessa nesse nesta neste aquela aquele todas todos outra outro outras outros mesmo mesma pelos pelas seria sendo
    fazer feito podem poder possa deve devem estar esta estao sejam tenha temos terao seja favor atualmente
    tambem apenas somente sempre nunca algum alguma nenhum nenhuma existe existem precisa precisamos necessario
    ticket sistema campo campos valor valores informar informado exemplo problema solucao criterio criterios
    aceite cliente usuario usuarios tela telas botao opcao dados registro registros ajuste ajustar corrigir
    correcao erro erros deveria abaixo acima conforme segue seguinte anexo imagem print where which should
    would there their about could these those`.split(/\s+/).filter(Boolean));

function normalize(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function ticketKeywords(text) {
    const words = normalize(text).split(/[^a-z0-9]+/).filter(w => w.length >= 5 && w.length <= 40 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
    return [...new Set(words)];
}

function keywordPaths(files, keywords, max = MAX_KEYWORD_PATHS) {
    if (!keywords.length) return [];
    const scored = [];
    for (const f of files) {
        const p = normalize(f);
        let score = 0;
        for (const k of keywords) if (p.includes(k)) score++;
        if (score > 0) scored.push({ f, score });
    }
    scored.sort((a, b) => b.score - a.score || a.f.length - b.f.length);
    return scored.slice(0, max).map(s => s.f);
}

// Arquivos citados literalmente no ticket (caminho/nome com extensão ou NomeDeClasse em
// CamelCase) resolvidos contra os arquivos versionados. Esses o plan lê completos.
function citedFiles(text, repos) {
    const src = String(text || '');
    const names = new Set();
    for (const m of src.matchAll(/[\w./-]+\.(?:java|js|ts|html|sql|xml|properties|ya?ml|json|jsp|css|md)\b/g)) names.add(m[0].replace(/^\.?\//, ''));
    const classes = new Set([...src.matchAll(/\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b/g)].map(m => m[0]));
    const hits = [];
    for (const repo of repos) {
        for (const f of repo.files) {
            const base = path.basename(f);
            const stem = base.replace(/\.[^.]+$/, '');
            const byPath = [...names].some(n => f === n || f.endsWith(`/${n}`) || (!n.includes('/') && base === n));
            if (byPath || classes.has(stem)) hits.push(`${repo.name}/${f}`);
            if (hits.length >= MAX_CITED_FILES) return hits;
        }
    }
    return hits;
}

function trackedFiles(repoPath) {
    return lsFiles(repoPath);
}

// repos: [{ name, path }] — o primeiro é o worktree do app-back (cwd do agente); os
// demais, os worktrees irmãos que existirem.
function planContextBlock({ ticket, contextMd = '', repos = [], sanitize = s => s }) {
    const desc = truncate(ticket?.description || '', TICKET_DESC_MAX_CHARS);
    const withFiles = repos.map((r, i) => ({ ...r, files: trackedFiles(r.path), main: i === 0 }));
    const cited = citedFiles(`${ticket?.subject || ''}\n${ticket?.description || ''}`, withFiles);
    const keywords = ticketKeywords(`${ticket?.subject || ''} ${ticket?.description || ''}`);

    const structure = [];
    for (const r of withFiles) {
        if (!r.files.length) continue;
        structure.push(`${r.name}${r.main ? ' (cwd)' : ` (${r.path})`} — ${r.files.length} arquivos versionados:`);
        for (const l of compressedTree(r.files, r.main ? MAX_TREE_NODES : MAX_SIBLING_TREE_NODES)) structure.push(`  ${l}`);
    }
    const matches = [];
    for (const r of withFiles) {
        for (const f of keywordPaths(r.files, keywords)) matches.push(`  ${r.name}/${f}`);
    }

    return sanitize([
        '',
        '=== CONTEXTO PRÉ-MONTADO PELO ORQUESTRADOR (nó plan) ===',
        'Use isto como ponto de partida em vez de reler o ticket inteiro ou abrir arquivos pra "conhecer o projeto" ' +
            '(ver "Orçamento de contexto" em .claude/commands/plan.md).',
        '',
        `--- Ticket #${ticket?.id ?? '?'}: ${ticket?.subject || ''} (descrição, primeiros ${TICKET_DESC_MAX_CHARS} caracteres) ---`,
        desc || '(sem descrição)',
        '',
        '--- Arquivos citados diretamente no ticket (estes sim: leia completos) ---',
        cited.length ? cited.map(c => `  ${c}`).join('\n') : '  (nenhum arquivo/classe versionado citado literalmente)',
        '',
        '--- Estrutura do projeto (só nomes; entre parênteses, nº de arquivos) ---',
        truncate(structure.join('\n'), STRUCTURE_MAX_CHARS),
        '',
        `--- Caminhos que casam com termos do ticket (${keywords.slice(0, 12).join(', ')}${keywords.length > 12 ? ', …' : ''}) ---`,
        matches.length ? truncate(matches.join('\n'), STRUCTURE_MAX_CHARS) : '  (nenhum)',
        '',
        `--- context.md da task (primeiros ${CONTEXT_MD_MAX_CHARS} caracteres) ---`,
        contextMd ? truncate(contextMd, CONTEXT_MD_MAX_CHARS) : '(ainda não existe)',
        '=== FIM DO CONTEXTO PRÉ-MONTADO ===',
    ].join('\n'));
}

// ---------------------------------------------------------------------------------
// Review: diff real (git diff HEAD + arquivos novos), nunca arquivo não modificado.

function untrackedAsDiff(repoPath, files) {
    let out = '';
    for (const f of files) {
        const abs = path.join(repoPath, f);
        let st;
        try { st = fs.statSync(abs); } catch { continue; }
        if (!st.isFile()) continue;
        if (st.size > MAX_UNTRACKED_FILE_BYTES) {
            out += `\ndiff --git a/${f} b/${f}\nnew file (${st.size} bytes — conteúdo omitido; leia o arquivo se o checklist exigir)\n`;
            continue;
        }
        const content = readOrEmpty(abs);
        if (content.includes('\u0000')) {
            out += `\ndiff --git a/${f} b/${f}\nnew binary file\n`;
            continue;
        }
        const lines = content.replace(/\n$/, '').split('\n');
        out += `\ndiff --git a/${f} b/${f}\nnew file mode 100644\n--- /dev/null\n+++ b/${f}\n@@ -0,0 +1,${lines.length} @@\n` +
            lines.map(l => `+${l}`).join('\n') + '\n';
    }
    return out;
}

function collectRepoDiff(repo) {
    let diff = '';
    try { diff = git(repo.path, ['diff', 'HEAD', ...EXCLUDE_PATHSPEC]); } catch { diff = ''; }
    const untracked = lsFiles(repo.path, ['--others', '--exclude-standard']);
    diff += untrackedAsDiff(repo.path, untracked);
    const tracked = gitLines(repo.path, ['-c', 'core.quotePath=false', 'diff', 'HEAD', '--name-only', ...EXCLUDE_PATHSPEC]);
    const changed = [...new Set([...tracked, ...untracked])];
    let stat = '';
    try { stat = git(repo.path, ['diff', 'HEAD', '--stat', ...EXCLUDE_PATHSPEC]).trim(); } catch { /* sem stat */ }
    if (untracked.length) stat += `${stat ? '\n' : ''} novos (untracked): ${untracked.join(', ')}`;
    return { ...repo, diff, changed, untracked, stat };
}

// Divide um diff unificado em seções por arquivo.
function splitByFile(diff) {
    const sections = [];
    for (const chunk of diff.split(/^(?=diff --git )/m)) {
        if (!chunk.trim()) continue;
        const m = chunk.match(/^diff --git a\/(\S+) b\/(\S+)/);
        sections.push({ file: m ? m[2] : '?', text: chunk });
    }
    return sections;
}

// Item 1: valor real de secret (via sanitize) ou padrão de token em linha ADICIONADA.
// Devolve só arquivos + tipo — nunca o valor.
const SECRET_PATTERNS = [
    { kind: 'atribuição de BITBUCKET_API_TOKEN/REDMINE_API_KEY com valor literal',
      re: /(BITBUCKET_API_TOKEN|REDMINE_API_KEY)\s*["']?\s*[:=]\s*["']?[A-Za-z0-9_\-=+/]{12,}/ },
    { kind: 'padrão de token Atlassian/Bitbucket (ATATT/ATBB)', re: /\b(ATATT|ATBB)[A-Za-z0-9_\-=]{20,}/ },
    { kind: 'cabeçalho Authorization com credencial literal', re: /Authorization["']?\s*[:=,]\s*["']?(Bearer|Basic)\s+[A-Za-z0-9_\-=+/.]{16,}/i },
    { kind: 'chave privada', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

function scanSecrets(repoDiffs, sanitize = s => s) {
    const findings = [];
    for (const r of repoDiffs) {
        for (const s of splitByFile(r.diff)) {
            const added = s.text.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).join('\n');
            if (!added) continue;
            if (sanitize(added) !== added) findings.push({ file: `${r.name}/${s.file}`, kind: 'valor real de um secret do ambiente (.env)' });
            for (const p of SECRET_PATTERNS) {
                if (p.re.test(added)) findings.push({ file: `${r.name}/${s.file}`, kind: p.kind });
            }
        }
    }
    return findings;
}

// Item 3: o projeto não tem linter Java configurado (sem checkstyle/spotless/pmd no
// pom) — o que dá pra rodar barato e deterministicamente é: `git diff --check`
// (whitespace/marcador de conflito), `node --check` nos .js e JSON.parse nos .json
// alterados. Compilação fica com o portão de pré-build e o nó test.
function runLint(repoDiffs) {
    const lines = [];
    for (const r of repoDiffs) {
        if (!r.changed.length) continue;
        let check = '';
        try { git(r.path, ['diff', 'HEAD', '--check', ...EXCLUDE_PATHSPEC]); } catch (e) { check = String(e.stdout || '').trim(); }
        if (check) lines.push(`FALHA ${r.name}: git diff --check\n${truncate(check, 1500)}`);
        for (const f of r.changed) {
            const abs = path.join(r.path, f);
            if (!fs.existsSync(abs)) continue;
            if (f.endsWith('.js')) {
                try {
                    execFileSync(process.execPath, ['--check', abs], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
                } catch (e) {
                    lines.push(`FALHA ${r.name}/${f}: node --check\n${truncate(String(e.stderr || '').trim(), 800)}`);
                }
            } else if (f.endsWith('.json')) {
                try { JSON.parse(fs.readFileSync(abs, 'utf8')); } catch (e) { lines.push(`FALHA ${r.name}/${f}: JSON inválido (${e.message})`); }
            }
        }
    }
    return {
        ok: lines.length === 0,
        summary: lines.length
            ? lines.join('\n')
            : 'OK — git diff --check limpo; .js alterados passam em node --check; .json alterados são JSON válido. ' +
              '(Sem linter Java configurado no projeto: compilação é coberta pelo pré-build/nó test.)',
    };
}

// Item 8: contrato OpenAPI da task (memory/runs/<task-id>/openapi-contract.yaml, só
// existe em task de endpoint — ver .claude/commands/plan.md) contra os .java alterados
// no diff de todos os worktrees. null = sem contrato (a linha nem entra no bloco).
const OPENAPI_MAX_CHARS = 4000;
function runOpenApiCheck(contractPath, repoDiffs) {
    if (!contractPath || !fs.existsSync(contractPath)) return null;
    const validator = require('./openapi-validator');
    const javaFiles = repoDiffs.flatMap(r => r.changed
        .filter(f => f.endsWith('.java'))
        .map(f => path.join(r.path, f))
        .filter(f => fs.existsSync(f)));
    const roots = repoDiffs.map(r => path.join(r.path, 'src', 'main', 'java')).filter(d => fs.existsSync(d));
    try {
        const result = validator.validate({ contractText: fs.readFileSync(contractPath, 'utf8'), contractFile: contractPath, javaFiles, roots });
        if (!result.resources.length) {
            return 'ATENÇÃO — existe openapi-contract.yaml mas nenhum Resource (@Path) alterado no diff. Se o endpoint já ' +
                'existia, rode `node scripts/lib/openapi-validator.js <contrato> <Resource.java> --md` apontando o Resource.';
        }
        const { fail, warn } = result.summary;
        const base = repoDiffs[0]?.path || process.cwd();
        return `${fail ? `FALHA — ${fail} [FAIL]` : 'OK — 0 [FAIL]'}, ${warn} [WARN] em ${result.summary.operations} operação(ões) ` +
            `(Resources: ${result.resources.map(f => path.relative(base, f)).join(', ')}):\n` +
            truncate(validator.toMarkdown(result, base), OPENAPI_MAX_CHARS);
    } catch (e) {
        return `ERRO lendo o contrato (${e.message}) — corrija o YAML ou confira manualmente.`;
    }
}

function reviewContextBlock({ repos = [], contextMd = '', contractPath = null, sanitize = s => s }) {
    const diffs = repos.map(collectRepoDiff).filter(r => r.changed.length);
    const secrets = scanSecrets(diffs, sanitize);
    const lint = runLint(diffs);
    const openapi = runOpenApiCheck(contractPath, diffs);

    const stat = diffs.length
        ? diffs.map(r => `${r.name}${r.name === repos[0]?.name ? ' (cwd)' : ` (${r.path})`}:\n${r.stat}`).join('\n\n')
        : '(nenhuma mudança não commitada em nenhum dos worktrees — confira se o Implement realmente escreveu código)';

    // Diff por arquivo até o teto; o que não couber vai só pelo nome.
    let budget = REVIEW_DIFF_MAX_CHARS;
    const shown = [];
    const omitted = [];
    for (const r of diffs) {
        for (const s of splitByFile(r.diff)) {
            if (s.text.length <= budget) {
                shown.push(r.name === repos[0]?.name ? s.text : `# repo: ${r.name} (${r.path})\n${s.text}`);
                budget -= s.text.length;
            } else {
                omitted.push(`${r.name}/${s.file}`);
            }
        }
    }

    const secretLine = secrets.length
        ? `ENCONTRADO — ${secrets.map(s => `${s.file} (${s.kind})`).join('; ')}. Valor não reproduzido aqui de propósito.`
        : 'nada encontrado (valores reais de BITBUCKET_API_TOKEN/REDMINE_API_KEY/*_TOKEN do ambiente e padrões de token checados nas linhas adicionadas).';

    return sanitize([
        '',
        '=== CONTEXTO PRÉ-MONTADO PELO ORQUESTRADOR (nó review) ===',
        'Revise a partir disto (ver "Orçamento de contexto" em .claude/commands/review.md). Nenhum arquivo não ' +
            'modificado vem aqui; abra um arquivo completo só se um item do checklist exigir.',
        '',
        '--- Arquivos alterados (git diff HEAD --stat + novos) ---',
        stat,
        '',
        '--- Pré-checagens já rodadas pelo orquestrador ---',
        `Item 1 (secret no diff): ${secretLine}`,
        `Item 3 (lint): ${lint.summary}`,
        ...(openapi ? [`Item 8 (contrato OpenAPI): ${openapi}`] : []),
        '',
        `--- Diff (git diff HEAD + arquivos novos; até ${REVIEW_DIFF_MAX_CHARS} caracteres) ---`,
        shown.length ? shown.join('') : '(vazio)',
        omitted.length ? `\n[diff omitido por tamanho — leia com \`git diff HEAD -- <arquivo>\` só o que o checklist exigir]: ${omitted.join(', ')}` : '',
        '',
        `--- context.md da task (primeiros ${CONTEXT_MD_MAX_CHARS} caracteres) ---`,
        contextMd ? truncate(contextMd, CONTEXT_MD_MAX_CHARS) : '(não existe)',
        '=== FIM DO CONTEXTO PRÉ-MONTADO ===',
    ].join('\n'));
}

module.exports = {
    truncate, TRUNCATION_MARK,
    TICKET_DESC_MAX_CHARS, CONTEXT_MD_MAX_CHARS, REVIEW_DIFF_MAX_CHARS,
    compressedTree, ticketKeywords, keywordPaths, citedFiles,
    planContextBlock, reviewContextBlock,
    collectRepoDiff, splitByFile, scanSecrets, runLint, runOpenApiCheck,
};
