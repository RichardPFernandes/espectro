// Leitura da linha "Arquivo:" de um passo do plano (PRI-205 S2).
//
// Módulo sem dependências, usado por plan-signals (sinais prospectivos) e por
// plan-scorer (aviso ao Plan quando a linha não é legível). Mantém a regra de ouro do
// §4.1: caminho que não dá pra ler com certeza é 'UNKNOWN', nunca lista parcial ou vazia.

const UNKNOWN = 'UNKNOWN';

// Nomes sem extensão que são arquivo de verdade. Outro identificador sem "." nem "/"
// (`InsightsIAService`, `analisarInsights`) é anotação, não arquivo.
// Extensão de arquivo reconhecida DENTRO de um texto com espaço: `a.js, b.js` é lista de
// caminhos numa crase só (linha ilegível), não anotação.
const FILE_EXT_IN_TEXT = /\.(?:java|js|mjs|cjs|ts|tsx|jsx|html|css|scss|less|json|ya?ml|xml|sql|md|properties|sh|py|vue|kt|gradle|toml|txt|csv|env)\b/i;
const EXTENSIONLESS = new Set(['Dockerfile', 'Makefile', 'Jenkinsfile', 'Procfile', 'CODEOWNERS', 'LICENSE', 'README', 'gradlew', 'mvnw']);

function normPath(p) {
    return String(p || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

// Sufixos de posição (`x.js:42`, `X.java::metodo`, `X.java#metodo`) e anotação entre
// parênteses não fazem parte do caminho.
function cleanToken(t) {
    return normPath(String(t).replace(/\s*\(.*$/, '').replace(/::.*$/, '').replace(/#.*$/, '').replace(/:\d+(?:[-:]\d+)*$/, ''));
}

/**
 * Item entre crases que é CLARAMENTE anotação, não arquivo: annotation (`@Path`), número
 * (branch `44042`), identificador sem "." nem "/" (classe, método, flag), texto com
 * espaço sem "/" (`extends X`, `GET status`), verbo + rota (`GET /api/x`) e caminho
 * absoluto (worktree/checkout fora do repo). Só estes saem da lista. Qualquer item com
 * "." ou "/" que não seja isso continua candidato e, se incompleto, derruba a linha
 * para UNKNOWN: o risco real é subestimar arquivos (§4.1), nunca superestimar.
 * @param {string} raw item entre crases, como escrito
 * @param {string} cleaned o mesmo item já limpo (cleanToken)
 */
function isAnnotation(raw, cleaned) {
    if (/^\s*\//.test(raw)) return true;
    if (/^[@#]/.test(cleaned) || /^\d+$/.test(cleaned)) return true;
    if (/^[A-Z]+\s+\//.test(cleaned)) return true;
    if (/\s/.test(cleaned) && !cleaned.includes('/') && !FILE_EXT_IN_TEXT.test(cleaned)) return true;
    if (!cleaned.includes('/') && !cleaned.includes('.') && !EXTENSIONLESS.has(cleaned)) return true;
    return false;
}

/**
 * @param {string} line linha "- Arquivo: ..." do passo
 * @returns {string[]|null} caminhos concretos, ou null se a linha não é legível
 */
function parsePathsLine(line) {
    const body = line.replace(/^\s*[-*]?\s*arquivos?\s*:\s*/i, '');
    const ticked = [...body.matchAll(/`([^`]+)`/g)].map(m => m[1]);
    let raw;
    if (ticked.length) {
        // Crase também serve a anotação (`@ApplicationScoped`, `extends X`, `44042`). Saem da
        // lista só os itens claramente anotação (isAnnotation); sobrando algum candidato, vale
        // ele. Sem nenhum candidato, vale o critério antigo (todos precisam ser caminho,
        // senão null). Candidato incompleto (`.../`, curinga, diretório, lista numa crase
        // só) derruba a linha para UNKNOWN: nunca subestimar.
        const cleaned = ticked.map(cleanToken);
        const kept = cleaned.filter((c, i) => !isAnnotation(ticked[i], c));
        raw = kept.length ? kept : cleaned;
    } else {
        // Elipse no fim ('a.js, b.js...') = lista truncada: o trim por item a engoliria.
        if (/(?:\.\.\.|\u2026)\s*$/.test(body)) return null;
        raw = body.split(/[,;]|\se\s/).map(t => t.trim().replace(/[.)]+$/, '')).map(cleanToken);
    }
    const out = [];
    for (const p of raw) {
        // Caminho concreto: sem "...", sem curinga, sem espaço (salvo entre crases); com "/" ou extensão.
        // Diretório (termina em "/") não é arquivo: lista incompleta => UNKNOWN.
        if (!p || /\/$/.test(p) || /\.\.\./.test(p) || (ticked.length && /[,;]|\se\s/.test(p)) || (!ticked.length && /\s/.test(p)) || /[*<>{}\u2026]/.test(p) || /^n\/a$/i.test(p) || !(/[/.]/.test(p) || EXTENSIONLESS.has(p))) return null;
        out.push(p);
    }
    return out.length ? [...new Set(out)] : null;
}

// `Arquivo:` escrito no meio da prosa do passo ("Resolver X. Arquivo: a.js, b.js. Critérios:
// AC-01"). Só vale com fronteira de frase antes (". ", "; ", ") " ou travessão) e "Arquivo"
// com maiúscula: "o arquivo: x" em texto corrido não é declaração. O trecho vai até o
// próximo rótulo do passo ou o fim da linha.
const INLINE_LABEL = /(?:[.;)]\s+|\s[\u2014\u2013-]\s)Arquivos?\s*:\s*/g;
const NEXT_LABEL = /\s*\b(?:Crit[e\u00e9]rios?|Verifica[c\u00e7][a\u00e3]o|Valida[c\u00e7][a\u00e3]o)\s*:/;

const INLINE_CRITERIOS = /(?:[.;)]\s+|\s[\u2014\u2013-]\s)Crit[e\u00e9]rios?\s*:\s*/gi;
const NEXT_LABEL_AFTER_CRITERIOS = /\s*\b(?:Arquivos?|Verifica[c\u00e7][a\u00e3]o|Valida[c\u00e7][a\u00e3]o)\s*:/i;

function inlineSegments(line) {
    const out = [];
    for (const m of line.matchAll(INLINE_LABEL)) {
        const rest = line.slice(m.index + m[0].length);
        const cut = rest.search(NEXT_LABEL);
        const seg = (cut === -1 ? rest : rest.slice(0, cut)).replace(/\s+$/, '');
        // "a.js, b.js..." / "…" indica lista truncada: mantém para o parser recusar. Só o ponto final da frase sai.
        out.push(/(?:\.\.\.|\u2026)$/.test(seg) ? seg : seg.replace(/\.+$/, ''));
    }
    return out;
}

/**
 * Caminhos declarados em UM passo, na linha "- Arquivo:" própria ou inline na prosa. Mais de
 * uma declaração no passo = lista possivelmente parcial => UNKNOWN (nunca subestimar
 * paths_decl; §4.1). Passo sem nenhuma declaração fica UNKNOWN: não há arquivo a ler.
 * @returns {{ paths: string[]|'UNKNOWN', fileLines: number }} fileLines = declarações "Arquivo:" achadas
 */
function declaredPaths(stepText) {
    const lines = String(stepText || '').split('\n');
    const labelLines = lines.filter(l => /^\s*[-*]?\s*arquivos?\s*:/i.test(l));
    const inline = lines.filter(l => !/^\s*[-*]?\s*arquivos?\s*:/i.test(l)).flatMap(inlineSegments);
    const total = labelLines.length + inline.length;
    // Menção "arquivo:" que nenhuma das duas formas reconheceu (negrito, minúsculo, após vírgula,
    // entre parênteses): com uma declaração válida no mesmo passo seria lista parcial => UNKNOWN.
    const mentions = lines.reduce((n, l) => n + (l.replace(/`[^`]*`/g, '').match(/\barquivos?\s*:/gi) || []).length, 0);
    if (total >= 1 && mentions > total) return { paths: UNKNOWN, fileLines: mentions };
    let paths = null;
    if (total === 1) paths = labelLines.length ? parsePathsLine(labelLines[0]) : parsePathsLine(`- Arquivo: ${inline[0]}`);
    return { paths: paths || UNKNOWN, fileLines: total };
}

/**
 * ACs citados em UM passo, na linha "Critérios:" própria (a linha inteira, como sempre) ou
 * inline na prosa ("... Critérios: AC-01, AC-02. Verificação: ..."). União das duas: nunca
 * perde um AC que o passo cita (um AC a menos subestima sensitive_decl e n_acs_step).
 */
function declaredAcIds(stepText) {
    const ids = new Set();
    for (const line of String(stepText || '').split('\n')) {
        if (/^\s*[-*]?\s*crit[e\u00e9]rios?\s*:/i.test(line)) {
            for (const id of line.match(/\bAC-\d+\b/g) || []) ids.add(id);
            continue;
        }
        for (const m of line.matchAll(INLINE_CRITERIOS)) {
            const rest = line.slice(m.index + m[0].length);
            const cut = rest.search(NEXT_LABEL_AFTER_CRITERIOS);
            for (const id of (cut === -1 ? rest : rest.slice(0, cut)).match(/\bAC-\d+\b/g) || []) ids.add(id);
        }
    }
    return [...ids];
}

module.exports = { UNKNOWN, normPath, parsePathsLine, declaredPaths, declaredAcIds, isAnnotation };
