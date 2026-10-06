// Enriquece memory/spec/<ticket>-spec.md com contexto histórico do Knowledge Graph
// (memory/knowledge-graph.json) e de memory/patterns.md, logo depois do /fetch-ticket
// gerar a spec e antes do /plan diagnosticar em cima dela.
//
// Achado de arquitetura que decide COMO isto é chamado: o watcher despacha
// fetch_ticket e plan na MESMA sessão Claude (uma única chamada a
// dispatchClaudeSegment, ver scripts/readmine-watcher.js) — não há dois despachos
// separados entre os quais o watcher (JS) possa chamar enrichSpec() diretamente. A
// integração segue o mesmo padrão já usado ali para spec-validator.js: o prompt da
// sessão única instrui o agente a rodar este script via CLI entre os dois comandos.
//
// O que faz:
//   a) extrai palavras-chave do spec.md — nomes de classe Java (sufixos comuns:
//      Service/Resource/Repository/...) e caminhos de arquivo citados;
//   b) casa cada uma contra os nós `type: "file"` de memory/knowledge-graph.json e,
//      por arquivo casado, lista quantos tickets diferentes já o tocaram (aresta
//      `touched_file`) e que fração precisou de re-implement (memory/runs(/_archive)/
//      <ticket>-*/state.json: history com mais de um "implement", ou mais de uma run
//      pro mesmo ticket = retrabalho entre ciclos, ex. Recusa QA);
//   c) casa o mesmo arquivo contra memory/project.yaml > regras_invioláveis (sem
//      parser de YAML — heurística por substring, ver matchesRegra) e contra
//      memory/decisions/*.md (lista os arquivos de decisão que citam a classe, nunca
//      parafraseia o conteúdo — "nunca invente" é princípio repetido em todo
//      .claude/commands/*.md deste projeto);
//   d) casa as palavras-chave contra memory/patterns.md, se existir (formato descrito
//      junto de parsePatterns — o arquivo não existe hoje neste checkout; a função
//      só documenta o contrato que consumiria).
//
// APPEND-only e idempotente: escreve só entre CONTEXT_BEGIN/CONTEXT_END, no fim do
// arquivo; nunca toca o resto da spec. Rodar de novo substitui só esse bloco — não
// duplica a cada fetch_ticket de uma Recusa QA (mesma técnica de
// scripts/lib/schema-watcher.js > upsertContextChecklist).
//
// Nunca falha o processo chamador: KG ausente, patterns.md ausente, project.yaml
// ausente, ou nenhuma palavra-chave casada — tudo isso é "nada a acrescentar", não
// erro (enrichSpec devolve { applied: false, reason }). Só quem chama a CLI decide o
// que fazer; o processo em si sempre sai 0.
//
// Uso como CLI: node scripts/lib/spec-enricher.js <spec.md> <task-id>

const fs = require('fs');
const path = require('path');
const kg = require('./knowledge-graph');

const CONTEXT_BEGIN = '<!-- spec-enricher:contexto-historico:inicio -->';
const CONTEXT_END = '<!-- spec-enricher:contexto-historico:fim -->';
const SECTION_HEADING = '## Contexto Histórico (gerado automaticamente)';
const MAX_TICKETS_LISTED = 3;
const MAX_DECISIONS_LISTED = 3;

// Sufixos de classe comuns neste projeto (ver módulos em memory/spec/index.yaml).
// Heurística deliberadamente ampla: um falso positivo aqui só gera uma consulta ao
// KG que não acha nada (sem custo real); um falso negativo perde contexto de verdade.
const CLASS_NAME_RE = /\b[A-Z][A-Za-z0-9]*(?:Service|Resource|Repository|Controller|Helper|Manager|Validator|Handler|Job|Listener|Filter|Component|Dao)\b/g;
const FILE_MENTION_RE = /\b[\w][\w.\-/]*\.(?:java|js|jsx|ts|tsx)\b/g;

const uniq = arr => [...new Set(arr)];
const truncate = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function extractKeywords(specText) {
    const text = String(specText || '');
    return {
        classNames: uniq(text.match(CLASS_NAME_RE) || []),
        fileMentions: uniq((text.match(FILE_MENTION_RE) || []).map(f => f.replace(/\\/g, '/'))),
    };
}

// Nós "file" do KG cujo caminho casa com um nome de classe (.../<Classe>.java) ou uma
// menção direta de arquivo no spec. Devolve Map<fileId, palavra-chave que casou>.
function matchFileNodes(graph, { classNames, fileMentions }) {
    const fileIds = Object.keys(graph.nodes).filter(id => graph.nodes[id]?.type === 'file');
    const hits = new Map();
    for (const cls of classNames) {
        const suffix = `/${cls}.java`;
        for (const id of fileIds) {
            if (!hits.has(id) && (id === `${cls}.java` || id.endsWith(suffix))) hits.set(id, cls);
        }
    }
    for (const f of fileMentions) {
        for (const id of fileIds) {
            if (!hits.has(id) && (id === f || id.endsWith(`/${f}`))) hits.set(id, f);
        }
    }
    return hits;
}

// Ticket ids (sem o prefixo TASK-) que tocaram um nó "file", na ordem em que a
// aresta `touched_file` foi vista.
function ticketsForFile(graph, fileId) {
    return uniq(graph.edges.filter(e => e.rel === 'touched_file' && e.to === fileId).map(e => e.from))
        .map(t => t.replace(/^TASK-/, ''));
}

// memory/project.yaml > regras_invioláveis, quebrado em bullets. Sem parser de YAML
// de verdade (o projeto não depende de nenhum): bullet = linha "  - ..." a 2 espaços;
// continuação = qualquer linha não-vazia mais indentada; o bloco termina na próxima
// chave de nível 0. Suficiente pro uso aqui (substring, não estrutura).
function readRegrasInvioláveis(mainRepo) {
    let text;
    try { text = fs.readFileSync(path.join(mainRepo, 'memory', 'project.yaml'), 'utf8'); } catch { return []; }
    const startIdx = text.indexOf('regras_invioláveis:');
    if (startIdx === -1) return [];
    const rest = text.slice(startIdx).split('\n').slice(1);
    const bullets = [];
    let cur = null;
    for (const line of rest) {
        if (/^[A-Za-zÀ-ÿ_]+:\s*$/.test(line)) break; // próxima chave de nível 0
        if (/^ {2}- /.test(line)) {
            if (cur) bullets.push(cur.join(' '));
            cur = [line.replace(/^ {2}- "?/, '').replace(/"\s*$/, '')];
        } else if (cur && line.trim()) {
            cur.push(line.trim().replace(/"\s*$/, ''));
        }
    }
    if (cur) bullets.push(cur.join(' '));
    return bullets;
}

// Uma regra "casa" um arquivo se o nome da classe (basename sem .java) aparece
// dentro do texto da regra — cobre prefixos de convenção deste projeto (ex.:
// "FCalculoFreteService" casando com a classe "CalculoFreteService") — ou se algum
// pacote br.com.mosistemas.app.* citado na regra, convertido pra caminho, é
// substring do caminho do arquivo.
function matchesRegra(fileId, regraText) {
    const className = path.basename(fileId, '.java');
    if (className.length > 3 && regraText.toLowerCase().includes(className.toLowerCase())) return true;
    const prefix = process.env.SPEC_RULE_PACKAGE_PREFIX;
    if (!prefix) return false;
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pkgs = regraText.match(new RegExp(`\\b${escaped}(?:\\.[a-z0-9_]+)+\\b`, 'gi')) || [];
    return pkgs.some(pkg => fileId.includes(pkg.replace(/\./g, '/')));
}

function findRegraFor(fileId, regras) {
    return regras.find(r => matchesRegra(fileId, r)) || null;
}

// memory/decisions/*.md que citam a classe do arquivo — ponteiro verificável, nunca
// paráfrase do conteúdo (ver nota "nunca invente" no topo do arquivo).
function decisionsForFile(mainRepo, fileId) {
    const className = path.basename(fileId, '.java');
    if (!className) return [];
    const dir = path.join(mainRepo, 'memory', 'decisions');
    let files;
    try { files = fs.readdirSync(dir); } catch { return []; }
    const hits = [];
    for (const f of files) {
        if (!f.endsWith('.md')) continue;
        let content;
        try { content = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
        if (content.includes(className)) hits.push(`memory/decisions/${f}`);
    }
    return hits;
}

// Runs (ativas ou arquivadas) de um ticket, por prefixo do nome do diretório. Só é
// chamada para tickets que já casaram um arquivo (poucos) — nunca varre
// memory/runs/ inteiro.
function runsForTicket(mainRepo, ticketId) {
    const bases = [path.join(mainRepo, 'memory', 'runs'), path.join(mainRepo, 'memory', 'runs', '_archive')];
    const states = [];
    for (const base of bases) {
        let entries;
        try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            if (!e.isDirectory() || !(e.name === ticketId || e.name.startsWith(`${ticketId}-`))) continue;
            try { states.push(JSON.parse(fs.readFileSync(path.join(base, e.name, 'state.json'), 'utf8'))); } catch { /* run ilegível: ignora */ }
        }
    }
    return states;
}

// Mais de uma run pro mesmo ticket já é retrabalho (ex.: Recusa QA reabrindo o
// ciclo); senão, olha se o history precisou passar por "implement" mais de uma vez
// na mesma run (loop de review/test reprovado).
function neededReimplement(states) {
    if (states.length > 1) return true;
    const history = states[0]?.history || [];
    return history.filter(n => n === 'implement').length > 1;
}

// Taxa de retry entre os tickets que tocaram um arquivo: fração dos tickets com
// pelo menos uma run localizada que precisou de re-implement. Tickets sem run
// localizável (rodou fora deste checkout, ou nunca chegou a rodar) entram no
// `resolved` só se achados — sub-relatar é mais seguro que inventar dado.
function retryRateFor(mainRepo, ticketIds) {
    let resolved = 0;
    let reworked = 0;
    for (const t of ticketIds) {
        const states = runsForTicket(mainRepo, t);
        if (!states.length) continue;
        resolved++;
        if (neededReimplement(states)) reworked++;
    }
    return { reworked, resolved };
}

// memory/patterns.md: lista de padrões conhecidos de falha/convenção, um bloco por
// padrão (bloco = parágrafo iniciado por "- "), formato esperado:
//
//   - keywords: endpoint, financeiro, fatura
//     padrao: endpoint financeiro
//     recomendacao: especificar tipo monetário nos critérios de aceite
//     evidencia: identificado em 6/12 runs similares
//
// "keywords" é obrigatório (senão o bloco nunca casa com nada); "padrao" e
// "recomendacao" também — sem eles não há o que reportar. "evidencia" é opcional.
// Tolerante à ordem das linhas dentro do bloco; aceita padrao/padrão e
// recomendacao/recomendação.
function parsePatterns(text) {
    const blocks = String(text || '').split(/\n(?=- )/).map(b => b.trim()).filter(Boolean);
    return blocks
        .map(b => {
            const field = name => {
                const m = new RegExp(`^-?\\s*${name}:\\s*(.+)$`, 'mi').exec(b);
                return m ? m[1].trim() : null;
            };
            return {
                keywords: (field('keywords') || '').split(',').map(k => k.trim().toLowerCase()).filter(Boolean),
                padrao: field('padrao') || field('padrão'),
                recomendacao: field('recomendacao') || field('recomendação'),
                evidencia: field('evidencia') || field('evidência'),
            };
        })
        .filter(p => p.keywords.length && p.padrao && p.recomendacao);
}

function applicablePatterns(mainRepo, specText, keywords) {
    let raw;
    try { raw = fs.readFileSync(path.join(mainRepo, 'memory', 'patterns.md'), 'utf8'); } catch { return []; }
    const patterns = parsePatterns(raw);
    if (!patterns.length) return [];
    const haystack = `${specText} ${keywords.classNames.join(' ')}`.toLowerCase();
    return patterns.filter(p => p.keywords.some(k => haystack.includes(k)));
}

function formatSection({ fileEntries, patterns }) {
    if (!fileEntries.length && !patterns.length) return null;
    const lines = [CONTEXT_BEGIN, SECTION_HEADING, ''];
    if (fileEntries.length) {
        lines.push('### Arquivos Possivelmente Tocados — Histórico');
        for (const f of fileEntries) {
            lines.push(`- \`${f.fileId}\`${f.regra ? ' → ⚠️ REGRA INVIOLÁVEL' : ''}`);
            if (f.regra) lines.push(`  ${truncate(f.regra, 160)}`);
            const sample = f.ticketsSample.join(', ') + (f.total > f.ticketsSample.length ? '...' : '');
            lines.push(`  Tocado em ${f.total} run(s) anterior(es) (${sample})`);
            if (f.retry.resolved > 0) {
                const pct = Math.round((f.retry.reworked / f.retry.resolved) * 100);
                lines.push(`  Taxa de retry: ${pct}% (${f.retry.reworked}/${f.retry.resolved} precisaram de re-implement)`);
            }
            if (f.decisions.length) lines.push(`  Decisões relacionadas: ${f.decisions.join(', ')}`);
        }
        lines.push('');
    }
    if (patterns.length) {
        lines.push('### Padrões Aplicáveis');
        for (const p of patterns) {
            const ev = p.evidencia ? ` (${p.evidencia})` : '';
            lines.push(`- Esta task parece ser de **${p.padrao}** → ${p.recomendacao}${ev}`);
        }
        lines.push('');
    }
    while (lines[lines.length - 1] === '') lines.pop();
    lines.push(CONTEXT_END);
    return lines.join('\n');
}

// APPEND-only + idempotente: nenhuma outra seção do arquivo é tocada; rodar de novo
// substitui só o bloco entre os marcadores (mesma técnica de
// scripts/lib/schema-watcher.js > upsertContextChecklist).
function upsertSection(specText, section) {
    const begin = specText.indexOf(CONTEXT_BEGIN);
    const end = begin === -1 ? -1 : specText.indexOf(CONTEXT_END, begin);
    const hasBlock = begin !== -1 && end !== -1;
    if (hasBlock) {
        const before = specText.slice(0, begin).replace(/\n+$/, '\n');
        const after = specText.slice(end + CONTEXT_END.length).replace(/^\n+/, '');
        if (!section) return `${before}${after}`;
        return `${before}\n${section}\n${after}`.replace(/\n{3,}/g, '\n\n');
    }
    if (!section) return specText;
    return `${specText.replace(/\n*$/, '')}\n\n${section}\n`;
}

// Ponto de entrada. Nunca lança por dado ausente/malformado — devolve
// { applied, reason|filesMatched/patternsMatched } sempre.
// specPath: caminho da spec (memory/spec/<ticket>-spec.md).
// taskId: task-id da run corrente — usado só pra não citar a própria task como
// "anterior" caso ela já tenha deixado rastro no KG (ex.: Recusa QA reabrindo o
// mesmo ticket, no meio do próprio ciclo).
function enrichSpec(specPath, taskId, opts = {}) {
    let specText;
    try {
        specText = fs.readFileSync(specPath, 'utf8');
    } catch (e) {
        return { applied: false, reason: `spec ilegível: ${e.message}` };
    }

    const cwd = opts.cwd || path.dirname(path.resolve(specPath));
    const mainRepo = opts.mainRepo || kg.mainRepoOf(cwd);
    const selfTicket = kg.ticketIdOf(taskId, null);

    let graph;
    try {
        // path.join direto (não kg.defaultGraphPath(mainRepo)): esse helper resolve o
        // repo de novo via `git rev-parse` a partir do argumento — em cima de um
        // mainRepo synthetic/de teste (sem .git) ele ignora o valor recebido e cai no
        // fallback pro checkout real deste projeto, lendo o KG errado.
        graph = kg.readGraph(opts.graphPath || path.join(mainRepo, 'memory', 'knowledge-graph.json'));
    } catch (e) {
        return { applied: false, reason: `knowledge-graph ilegível: ${e.message}` };
    }

    const keywords = extractKeywords(specText);
    const matched = matchFileNodes(graph, keywords);
    const regras = readRegrasInvioláveis(mainRepo);

    const fileEntries = [];
    for (const fileId of matched.keys()) {
        const tickets = ticketsForFile(graph, fileId).filter(t => t !== selfTicket);
        if (!tickets.length) continue;
        fileEntries.push({
            fileId,
            regra: findRegraFor(fileId, regras),
            decisions: decisionsForFile(mainRepo, fileId).slice(0, MAX_DECISIONS_LISTED),
            total: tickets.length,
            ticketsSample: tickets.slice(0, MAX_TICKETS_LISTED).map(t => `TASK-${t}`),
            retry: retryRateFor(mainRepo, tickets),
        });
    }

    const patterns = applicablePatterns(mainRepo, specText, keywords);
    const section = formatSection({ fileEntries, patterns });
    if (!section) return { applied: false, reason: 'nenhum arquivo ou padrão casado', filesChecked: matched.size };

    fs.writeFileSync(specPath, upsertSection(specText, section));
    return { applied: true, filesMatched: fileEntries.length, patternsMatched: patterns.length };
}

module.exports = {
    CONTEXT_BEGIN, CONTEXT_END, SECTION_HEADING,
    extractKeywords, matchFileNodes, ticketsForFile, readRegrasInvioláveis, matchesRegra, findRegraFor,
    decisionsForFile, runsForTicket, neededReimplement, retryRateFor, parsePatterns, applicablePatterns,
    formatSection, upsertSection, enrichSpec,
};

if (require.main === module) {
    const [specPath, taskId] = process.argv.slice(2);
    if (!specPath || !taskId) {
        console.error('Uso: node scripts/lib/spec-enricher.js <spec.md> <task-id>');
        process.exit(2);
    }
    const start = Date.now();
    let result;
    try {
        result = enrichSpec(specPath, taskId);
    } catch (e) {
        console.log(`[spec-enricher] falha inesperada (seguindo sem enriquecer): ${e.message}`);
        process.exit(0);
    }
    const ms = Date.now() - start;
    console.log(result.applied
        ? `[spec-enricher] ${specPath}: ${result.filesMatched} arquivo(s), ${result.patternsMatched} padrão(ões) — ${ms}ms`
        : `[spec-enricher] ${specPath}: nada a acrescentar (${result.reason}) — ${ms}ms`);
    process.exit(0);
}
