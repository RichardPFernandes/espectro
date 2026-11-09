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
        raw = body.split(/[,;]|\se\s/).map(t => t.trim().replace(/[.)]+$/, '')).map(cleanToken);
    }
    const out = [];
    for (const p of raw) {
        // Caminho concreto: sem "...", sem curinga, sem espaço (salvo entre crases); com "/" ou extensão.
        // Diretório (termina em "/") não é arquivo: lista incompleta => UNKNOWN.
        if (!p || /\/$/.test(p) || /\.\.\./.test(p) || (ticked.length && /[,;]|\se\s/.test(p)) || (!ticked.length && /\s/.test(p)) || /[*<>{}]/.test(p) || !(/[/.]/.test(p) || EXTENSIONLESS.has(p))) return null;
        out.push(p);
    }
    return out.length ? [...new Set(out)] : null;
}

/**
 * Caminhos declarados em UM passo. Mais de uma linha "Arquivo:" = lista possivelmente
 * parcial => UNKNOWN (nunca subestimar paths_decl; §4.1).
 * @returns {{ paths: string[]|'UNKNOWN', fileLines: number }} fileLines = linhas "Arquivo:" achadas
 */
function declaredPaths(stepText) {
    const lines = String(stepText || '').split('\n');
    const fileLines = lines.filter(l => /^\s*[-*]?\s*arquivos?\s*:/i.test(l));
    const fileLine = fileLines.length === 1 ? fileLines[0] : null;
    return { paths: (fileLine && parsePathsLine(fileLine)) || UNKNOWN, fileLines: fileLines.length };
}

module.exports = { UNKNOWN, normPath, parsePathsLine, declaredPaths, isAnnotation };
