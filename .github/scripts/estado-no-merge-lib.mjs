// Estado no merge (F0.9 AC-02): decide o que fazer com a issue do Linear quando um PR é mesclado.
// Funções puras, sem rede nem disco. A CLI (estado-no-merge.mjs) busca os dados e escreve.

/**
 * IDs `PRI-N` citados como `Refs PRI-N` (ou `Refs: PRI-N`) no título e no corpo do PR.
 * Sem distinção de caixa, em ordem de aparição, sem repetição. `Fixes`/`Closes` não contam.
 * @param {string} [title]
 * @param {string} [body]
 * @returns {string[]} IDs normalizados em maiúsculas, ex.: ['PRI-399']
 */
export function parseRefs(title, body) {
    const text = `${title ?? ''}\n${body ?? ''}`;
    const out = new Set();
    for (const m of text.matchAll(/\brefs:?[ \t]+pri-(\d+)\b/gi)) out.add(`PRI-${m[1]}`);
    return [...out];
}

/**
 * Nível do PR pelo rótulo `processo:*`.
 * @param {Array<string|{name: string}>} [labels] lista de nomes ou objetos `{ name }` (evento do GitHub)
 * @param {Record<string, string>} levels mapa `levels` do `.github/processo.json`
 * @returns {string|null} 'leve' | 'medio' | 'alto', ou null sem rótulo de nível ou com mais de um
 */
export function levelFromLabels(labels, levels) {
    const keys = Object.keys(levels ?? {});
    const names = (labels ?? []).map((l) => String(typeof l === 'string' ? l : l?.name ?? '').toLowerCase());
    const found = [...new Set(names.filter((n) => keys.includes(n)))];
    return found.length === 1 ? levels[found[0]] : null;
}

/**
 * @typedef {{ tipo: 'pr', n: number } | { tipo: 'filha', id: string }} Pendencia
 *   `pr`: outro PR aberto anexado à issue; `filha`: issue filha aberta.
 */

/**
 * Decide a ação sobre uma issue.
 * @param {{ level: string|null, otherOpenPrs?: number[], openChildren?: string[] }} input
 *   otherOpenPrs: números de outros PRs abertos anexados; openChildren: IDs das filhas abertas.
 * @returns {{ acao: 'nada'|'done'|'estado', motivo: string, pendencias: Pendencia[] }}
 *   'nada': alto ou sem nível, não escreve; 'done': mover para Done e reescrever Estado;
 *   'estado': só reescrever Estado e Próximo passo com as pendências.
 */
export function decide({ level, otherOpenPrs = [], openChildren = [] }) {
    if (level === 'alto') return { acao: 'nada', motivo: 'nível alto: Done só com aceite do Richard', pendencias: [] };
    if (level !== 'leve' && level !== 'medio') return { acao: 'nada', motivo: 'sem rótulo de nível único (processo:*)', pendencias: [] };
    const pendencias = [
        ...otherOpenPrs.map((n) => ({ tipo: 'pr', n })),
        ...openChildren.map((id) => ({ tipo: 'filha', id })),
    ];
    if (pendencias.length === 0) return { acao: 'done', motivo: `nível ${level} sem PR aberto nem filha aberta`, pendencias };
    return { acao: 'estado', motivo: `nível ${level} com pendência: ${pendencias.map(pendenciaText).join(', ')}`, pendencias };
}

/** @param {Pendencia} p */
export function pendenciaText(p) {
    return p.tipo === 'pr' ? `PR #${p.n}` : `filha ${p.id}`;
}

const LINES = [['estado', 'Estado'], ['proximo', 'Próximo passo']];

/**
 * Troca o texto depois de `**Estado:**` e `**Próximo passo:**` (primeira ocorrência de cada, em
 * início de linha, com prefixo de lista opcional, que é preservado). O resto fica intacto.
 * @param {string} description
 * @param {{ estado: string, proximo: string }} values
 * @returns {{ text: string, changed: boolean, missing: string[] }} missing: rótulos das linhas não achadas
 */
export function rewriteEstado(description, { estado, proximo }) {
    const values = { estado, proximo };
    let text = String(description ?? '');
    const missing = [];
    for (const [key, label] of LINES) {
        const re = new RegExp(`^([ \\t]*(?:[-*+][ \\t]+)?\\*\\*${label}:\\*\\*)[^\\r\\n]*`, 'm');
        if (!re.test(text)) { missing.push(label); continue; }
        text = text.replace(re, (_, head) => `${head} ${values[key]}`);
    }
    return { text, changed: text !== String(description ?? ''), missing };
}

/**
 * Frases de Estado e Próximo passo.
 * @param {{ pr: number, data: string, acao: 'done'|'estado', pendencias?: Pendencia[] }} input data em AAAA-MM-DD
 * @returns {{ estado: string, proximo: string }}
 */
export function estadoText({ pr, data, acao, pendencias = [] }) {
    if (acao === 'done') return { estado: `PR #${pr} mesclado em ${data}; issue em Done pela Action.`, proximo: 'nenhum.' };
    return { estado: `PR #${pr} mesclado em ${data}.`, proximo: `falta ${pendencias.map(pendenciaText).join(', ')}.` };
}
