// PRI-366 (F2 da PRI-363, U-09): inventário "mecanismo × versão × prova" da CLI do Claude Code.
//
// Função pura: recebe a versão da CLI instalada e devolve uma linha por mecanismo que depende
// de prova por versão, mais o veredito. Não lê disco, rede nem relógio; quem descobre a versão
// é o comando scripts/cli-proof-inventory.js (`claude --version`, offline).
//
// Regra de validade (R8, Richard 15/11): a prova vale só para a versão EXATA. Versão nova fica
// UNVERIFIED até ter prova própria. As listas de versões provadas não são copiadas aqui: são as
// mesmas que o código usa (model-routing.SUBAGENT_MECHANISM_PROOF) ou declara ao lado da função
// provada (claude-account.PLUGIN_NEUTRALIZATION_PROOF).
//
// - required: true → sem prova na versão instalada, o inventário falha (ok = false).
// - required: false → o mecanismo segue UNKNOWN em toda versão e o código nunca o aplica
//   (esforço do subagente, U1/U-07); aparece no inventário, mas não reprova.

const { SUBAGENT_MECHANISM_PROOF } = require('./model-routing');
const { PLUGIN_NEUTRALIZATION_PROOF } = require('./claude-account');

const MECHANISMS = Object.freeze([
    Object.freeze({
        id: 'subagent_model', unknown: 'U-06', required: true,
        what: 'modelo do subagente por papel via --agents (U10-a)',
        proof_refs: SUBAGENT_MECHANISM_PROOF.proof_refs,
        source: 'scripts/lib/model-routing.js SUBAGENT_MECHANISM_PROOF',
    }),
    Object.freeze({
        id: 'plugin_neutralization', unknown: 'U-08', required: true,
        what: 'jev-model-router desligado pelo --settings gerado (SP-2)',
        proof_refs: PLUGIN_NEUTRALIZATION_PROOF.proof_refs,
        source: 'scripts/lib/claude-account.js PLUGIN_NEUTRALIZATION_PROOF',
    }),
    Object.freeze({
        id: 'subagent_effort', unknown: 'U-07', required: false,
        what: 'esforço do subagente por papel',
        proof_refs: Object.freeze({}),
        source: 'scripts/lib/model-routing.js subagentRoles (effort_enforcement = UNKNOWN fixo)',
        unknown_reason: 'SEM_PROBE: o transcript não registra o esforço do subagente e o despacho nunca o aplica',
    }),
]);

const VERSION = /^\d+\.\d+\.\d+$/;

/** Extrai X.Y.Z da saída de `claude --version` ("2.1.325 (Claude Code)"); senão null. */
function parseCliVersion(text) {
    const m = /(\d+\.\d+\.\d+)/.exec(String(text || ''));
    return m ? m[1] : null;
}

function compareVersions(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
    return 0;
}

/**
 * @param {{ cliVersion: string|null }} input
 * @returns {{ cli_version: string, rows: object[], missing: string[], ok: boolean }}
 */
function inventory({ cliVersion } = { cliVersion: null }) {
    const v = typeof cliVersion === 'string' && VERSION.test(cliVersion.trim()) ? cliVersion.trim() : null;
    const rows = MECHANISMS.map(m => {
        const ref = v && Object.hasOwn(m.proof_refs, v) ? m.proof_refs[v] : null;
        const status = ref ? 'PROOF_OBTAINED' : (m.required ? 'UNVERIFIED' : 'UNKNOWN');
        const reason = ref ? null : (m.unknown_reason || (v ? 'CLI_VERSION_NOT_PROVEN' : 'CLI_VERSION_UNKNOWN'));
        return {
            mechanism: m.id, unknown: m.unknown, required: m.required, what: m.what,
            proven_versions: Object.keys(m.proof_refs).filter(x => VERSION.test(x)).sort(compareVersions),
            installed: v || 'UNKNOWN', status, proof_ref: ref, reason, source: m.source,
        };
    });
    const missing = rows.filter(r => r.required && r.status !== 'PROOF_OBTAINED').map(r => r.mechanism);
    return { cli_version: v || 'UNKNOWN', rows, missing, ok: missing.length === 0 };
}

/** Tabela em texto para o terminal. */
function formatInventory(inv, { versionSource = null } = {}) {
    const head = ['mecanismo', 'unknown', 'obrigatório', 'versões com prova', `instalada (${inv.cli_version})`, 'prova ou motivo'];
    const body = inv.rows.map(r => [r.mechanism, r.unknown, r.required ? 'sim' : 'não',
        r.proven_versions.join(', ') || '-', r.status, r.proof_ref || r.reason]);
    const widths = head.map((h, i) => Math.max(h.length, ...body.map(row => String(row[i]).length)));
    const line = row => row.map((c, i) => String(c).padEnd(widths[i])).join(' | ').trimEnd();
    const out = [
        `CLI instalada: ${inv.cli_version}${versionSource ? ` (${versionSource})` : ''}`,
        line(head),
        widths.map(w => '-'.repeat(w)).join('-|-'),
        ...body.map(line),
        inv.ok
            ? `Resultado: OK, todo mecanismo obrigatório tem prova na ${inv.cli_version}.`
            : inv.cli_version === 'UNKNOWN'
                ? `Resultado: FALHA, versão da CLI desconhecida; nenhuma prova se aplica (${inv.missing.join(', ')}).`
                : `Resultado: FALHA, sem prova na ${inv.cli_version}: ${inv.missing.join(', ')}.`,
    ];
    return `${out.join('\n')}\n`;
}

module.exports = { MECHANISMS, inventory, formatInventory, parseCliVersion, compareVersions };
