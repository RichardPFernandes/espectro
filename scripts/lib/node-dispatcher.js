// Despacho de nó importável: "roda o próximo nó da task ativa deste ticket" fora do
// tick do watcher — usado pelo replay (scripts/replay-cycle.js) e por quem mais
// precisar despachar um único ticket. Não duplica a lógica de despacho: delega pro
// dispatchTicket do próprio watcher (scripts/readmine-watcher.js), então valem os
// mesmos portões (spec, plano, pré-build, churn), lease de nó, escopo de teste,
// custo por nó e redação de secrets do despacho normal.
//
// O watcher é carregado sob demanda (require tem custo: .env, schema, módulos) e lê
// as flags do process.argv no require — --follow do processo chamador vale aqui
// também (espera o agente e encadeia os próximos nós, como no tick com --follow).
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(process.env.REPO_PATH || process.cwd());
// Mesmo teto do tick() com --follow: estado que não converge não vira loop infinito.
const MAX_FOLLOW_SEGMENTS = 30;

let watcher = null;
let watcherRepoPath = null;
let watcherContext = null;
const CONTEXT_KEYS = [
    'REPO_PATH', 'REDMINE_URL', 'REDMINE_USER_ID', 'BITBUCKET_WORKSPACE',
    'BITBUCKET_REPO_SLUG', 'BITBUCKET_EMAIL', 'BITBUCKET_ACCOUNT_ID', 'BITBUCKET_PR_REPOS',
    'WATCHER_MAIN_REPO_NAME', 'WATCHER_SIBLING_REPOS', 'WATCHER_JAVA_HOME',
    'PRE_BUILD_COMMAND', 'TEST_COMMAND', 'TEST_SCOPED_COMMAND', 'SPEC_TEMPLATE_URL',
    'CONSOLIDATOR_MODULE_KEYWORDS_FILE', 'OPENAPI_RESPONSE_FACTORY_FILE', 'SPEC_RULE_PACKAGE_PREFIX',
];
const secretKey = key => /(_TOKEN|_API_KEY|_SECRET|_PASSWORD)$/.test(key) || key === 'NOTIFY_WEBHOOK_URL';
function contextOf(env) {
    const keys = new Set([...CONTEXT_KEYS, ...Object.keys(env).filter(secretKey)]);
    return Object.fromEntries([...keys].map(key => [key, String(env[key] ?? '')]));
}
function sameContext(actual, expected) {
    return [...new Set([...Object.keys(actual), ...Object.keys(expected)])]
        .every(key => String(actual[key] ?? '') === String(expected[key] ?? ''));
}

// O watcher exige REPO_PATH (deriva WORKSPACE dele no require). Mesma precedência do
// loadDotEnv do watcher: env já setada > .env do consumidor > cwd do consumidor.
function ensureRepoPath({ repoPath, env } = {}) {
    if (env) {
        for (const [key, value] of Object.entries(env)) {
            if (key === 'REPO_PATH' || key === 'PRISMA_ROOT') continue;
            if (String(value ?? '') !== String(process.env[key] ?? '')) {
                throw new Error('ambiente do dispatcher difere do processo configurado; use um processo próprio admitido');
            }
        }
    }
    if (repoPath) process.env.REPO_PATH = path.resolve(repoPath);
    if (process.env.REPO_PATH) return;
    try {
        const line = fs.readFileSync(path.join(REPO_ROOT, '.env'), 'utf8').split('\n')
            .map(l => l.trim()).find(l => l.startsWith('REPO_PATH='));
        if (line) {
            process.env.REPO_PATH = line.slice('REPO_PATH='.length).trim().replace(/^(['"])(.*)\1$/, '$2');
            return;
        }
    } catch { /* sem .env: cai no default */ }
    process.env.REPO_PATH = REPO_ROOT;
}

function loadWatcher(options = {}) {
    const requested = path.resolve(options.repoPath || options.env?.REPO_PATH || process.env.REPO_PATH || process.cwd());
    if (process.env.REPO_PATH && path.resolve(process.env.REPO_PATH) !== requested) throw new Error('contexto do dispatcher difere do consumidor do processo; use um processo próprio admitido');
    if (watcher && watcherRepoPath !== requested) throw new Error('watcher já carregado para outro consumidor; use um processo separado');
    if (watcherContext && (!sameContext(contextOf(process.env), watcherContext) ||
        !sameContext(contextOf({ ...process.env, ...options.env }), watcherContext))) {
        throw new Error('contexto do runtime já carregado mudou; use um processo próprio admitido');
    }
    ensureRepoPath({ ...options, repoPath: requested });
    if (path.resolve(process.env.REPO_PATH) !== requested) throw new Error('contexto do consumidor não corresponde ao root solicitado');
    if (!watcher) {
        watcherRepoPath = path.resolve(process.env.REPO_PATH);
        watcher = require('../readmine-watcher');
        watcherContext = Object.freeze(contextOf(process.env));
    }
    return watcher;
}

// Ticket do Redmine (o dispatchTicket precisa de status e "Branch Liberação"). Redmine
// fora do ar: monta o mínimo a partir de state.redmine_ticket (base_branch → campo).
async function resolveTicket(w, ticketId, fallbackState = null) {
    let ticket = null;
    try {
        ticket = await w.fetchTicketById(ticketId);
    } catch (e) {
        console.warn(`[dispatch] #${ticketId}: Redmine indisponível (${e.message}) — uso os dados do state.json.`);
    }
    if (ticket) return ticket;
    const rt = fallbackState?.redmine_ticket;
    const liberacao = Object.entries(w.BASE_BY_LIBERACAO).find(([, base]) => base === rt?.base_branch)?.[0];
    if (!rt || !liberacao) {
        throw new Error(`ticket #${ticketId} não encontrado no Redmine e state.json sem redmine_ticket.base_branch reconhecido`);
    }
    return {
        id: ticketId,
        subject: rt.subject || '',
        tracker: { name: rt.tracker || '?' },
        status: { name: 'Em Desenvolvimento' },
        custom_fields: [{ name: 'Branch Liberação', value: liberacao }],
    };
}

// Despacha o próximo nó da task ativa do ticket (state.node). Sem --follow: um segmento,
// agente destacado (volta logo). Com --follow: encadeia até parar de avançar.
async function dispatchNode({ ticketId, fallbackState = null, follow = process.argv.includes('--follow'), repoPath, env }) {
    const w = loadWatcher({ repoPath, env });
    const ticket = await resolveTicket(w, ticketId, fallbackState);
    let result = await w.dispatchTicket(ticket);
    const segments = [result];
    while (follow && result.action === 'dispatched' && segments.length < MAX_FOLLOW_SEGMENTS) {
        result = await w.dispatchTicket(ticket);
        segments.push(result);
    }
    return { ...result, segments: segments.length };
}

async function postNote(ticketId, text) {
    return loadWatcher().postRedmineNote(ticketId, text);
}

module.exports = { dispatchNode, postNote, resolveTicket, loadWatcher, ensureRepoPath, MAX_FOLLOW_SEGMENTS };
