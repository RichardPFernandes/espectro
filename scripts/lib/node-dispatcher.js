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

// O watcher exige REPO_PATH (deriva WORKSPACE dele no require). Mesma precedência do
// loadDotEnv do watcher: env já setada > .env do consumidor > cwd do consumidor.
function ensureRepoPath({ repoPath, env } = {}) {
    if (env) Object.assign(process.env, env);
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
    if (watcher && watcherRepoPath !== requested) throw new Error('watcher já carregado para outro consumidor; use um processo separado');
    if (!watcher) {
        ensureRepoPath(options);
        watcherRepoPath = path.resolve(process.env.REPO_PATH);
        watcher = require('../readmine-watcher');
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
