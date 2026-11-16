'use strict';
// PRI-315 (L1 da PRI-206): forma do bloqueio de subagente no argv do `claude -p`.
//
// AS-IS: `--disallowedTools Agent,Task` tira Agent/Task da lista de ferramentas, que é o 1º
// segmento do prompt, e o 1º request do nó deixa de ler o prefixo do cache dos outros nós.
// Com a flag WATCHER_PLAN_DENY_SETTINGS ligada, o mesmo bloqueio vai por `permissions.deny`
// (JSON inline em `--settings`): a lista de ferramentas fica igual e a chamada é recusada.
//
// Run roteada (PRI-233 T7) já leva `--settings` com o arquivo da prova SP-2; como dois
// `--settings` não estão provados no CLI, ela fica no AS-IS (decisão D1 da SPEC).

// Nós que nunca abrem subagente: no plan, um Explore em Opus custou 2,5× a sessão
// inteira (#43590) lendo arquivos Java completos. O review ainda pode chamar o
// subagente de domínio (security-reviewer/schema-guardian) — ver review.md.
const NO_SUBAGENT_NODES = new Set(['plan']);

const BLOCKED_TOOLS = ['Agent', 'Task'];
const DENY_SETTINGS_JSON = JSON.stringify({ permissions: { deny: BLOCKED_TOOLS } });

function planDenySettingsEnabled(env = process.env) {
    return /^(1|true|sim)$/i.test(env.WATCHER_PLAN_DENY_SETTINGS || '');
}

// PRI-353 (T6, AC5): WATCHER_PLAN_IMPLEMENT_CHAIN (desligada por padrão) permite um segmento
// [plan, implement] na mesma sessão. O bloqueio de subagente é por sessão, não por nó: se fosse
// aplicado ao segmento, o implement herdaria o bloqueio do plan. Então o segmento encadeado sai
// sem bloqueio no argv e o "plan sem subagente" fica só como instrução de texto (decisão do
// Richard sobre enforcement pendente). Plan avulso e fetch_ticket+plan seguem como hoje.
function planImplementChainEnabled(env = process.env) {
    return /^(1|true|sim)$/i.test(env.WATCHER_PLAN_IMPLEMENT_CHAIN || '');
}

function isPlanImplementChain(nodes) {
    return Array.isArray(nodes) && nodes.length === 2 && nodes[0] === 'plan' && nodes[1] === 'implement';
}

function subagentBlockArgs({ nodes, routed = false, denySettings = false, chain = false }) {
    if (!Array.isArray(nodes) || !nodes.some(n => NO_SUBAGENT_NODES.has(n))) return [];
    if (chain && isPlanImplementChain(nodes)) return [];
    if (denySettings && !routed) return ['--settings', DENY_SETTINGS_JSON];
    return ['--disallowedTools', BLOCKED_TOOLS.join(',')];
}

module.exports = { NO_SUBAGENT_NODES, BLOCKED_TOOLS, DENY_SETTINGS_JSON, planDenySettingsEnabled, planImplementChainEnabled, isPlanImplementChain, subagentBlockArgs };
