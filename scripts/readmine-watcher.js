// Modo DRY-RUN (DRY_RUN=true no ambiente do processo — lido ANTES do loadDotEnv, então
// uma linha no .env não liga): ciclo inteiro com fixture, agente simulado e zero chamada
// externa (ver scripts/lib/dry-run.js). A guarda de rede entra antes de qualquer
// require de child_process/http, pra valer também pros bindings desestruturados abaixo.
// Não é a flag --dry-run (DRY_RUN mais abaixo), que só loga e não escreve nada.
const dryRun = require('./lib/dry-run');
const SIMULATE = dryRun.isEnabled(process.env);
if (SIMULATE) dryRun.installNetworkGuard();
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execSync, execFileSync, spawn } = require('child_process');
const specValidator = require('./lib/spec-validator');
const specRepairer = require('./lib/spec-repairer');
const { withClaudeAccount, resolveClaudeAccount, listClaudeAccounts } = require('./lib/claude-account');
const nodeLease = require('./lib/node-lease');
const invalidate = require('./invalidate');
const nodeEvents = require('./lib/node-events');
const { readAndValidateState } = require('./validate-state');
const costTracking = require('./lib/cost-tracking');
const transcriptWriter = require('./lib/transcript-writer');
const sanitizeLog = require('./sanitize-log');
const serviceDetector = require('./lib/service-detector');
const buildValidator = require('./lib/build-validator');
const planScorer = require('./lib/plan-scorer');
const schemaWatcher = require('./lib/schema-watcher');
const prStatusPoll = require('./lib/pr-status-poll');
const { getPRStatus } = require('./check-pr-status');
const { cleanupWorktrees, dashboardBase } = require('./lib/worktree-cleanup');
const acRegistry = require('./lib/ac-registry');
const acProvenance = require('./lib/ac-provenance');
const specAuthority = require('./lib/spec-authority');
const specChange = require('./lib/spec-change');
const cleanupRuns = require('./cleanup-runs');
const stateWriter = require('./state-writer');
const cas = require('./cas');
const knowledgeGraph = require('./lib/knowledge-graph');
const memoryConsolidator = require('./memory-consolidator');
const churnDetector = require('./lib/churn-detector');
const cycleReplayer = require('./lib/cycle-replayer');
const qaJournal = require('./lib/redmine-journal-fetcher');
const qaCycles = require('./lib/qa-cycles');
const { GracefulShutdown } = require('./lib/graceful-shutdown');
const watcherLock = require('./lib/watcher-lock');
const watcherHealth = require('./lib/watcher-health');
const promptContext = require('./lib/prompt-context');
const { redmineFetch: realRedmineFetch } = require('./lib/redmine-fetch');
const specGenerator = require('./lib/spec-generator');
const cycleNotifications = require('./lib/cycle-notifications');
const humanInputIntent = require('./lib/human-input-intent');
const dom06 = require('./lib/dom06-attempt');

// Consumer env loads before watcher initialization. Explicit REPO_PATH wins;
// otherwise the caller must run in the consumer root. Candidate code has no .env.
function loadDotEnv(envPath) {
    if (!fs.existsSync(envPath)) return;
    for (const rawLine of fs.readFileSync(envPath, 'utf8').split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (!(key in process.env)) process.env[key] = value;
    }
}
loadDotEnv(path.join(process.env.REPO_PATH || process.cwd(), '.env'));

// Redação de secrets na saída dos agentes (ver scripts/sanitize-log.js). Construído
// logo depois do loadDotEnv() pra enxergar os secrets vindos do .env; avisa aqui, uma
// vez, se algum secret for curto demais pra ser redigido com segurança.
const sanitizeAgentOutput = sanitizeLog.buildSanitizer(process.env);
const SANITIZE_LOG_SCRIPT = path.join(__dirname, 'sanitize-log.js');

// Em DRY-RUN nada disto é chamado de verdade — os defaults só existem pra rodar sem .env.
const REDMINE_URL = process.env.REDMINE_URL || (SIMULATE ? 'https://redmine.dry-run.invalid' : undefined);
const REDMINE_API_KEY = process.env.REDMINE_API_KEY;
const REPO_PATH = path.resolve(process.env.REPO_PATH || process.cwd());
const PRISMA_ROOT = path.resolve(__dirname, '..');
// DRY-RUN: tickets do fixture (DRY_RUN_FIXTURE, padrão scripts/fixtures/ticket-example.json)
// no lugar do Redmine — toda chamada REST do watcher cai no fake (lib/dry-run.js).
const DRY_RUN_FIXTURE_PATH = SIMULATE ? dryRun.resolveFixturePath(process.env, REPO_PATH) : null;
const DRY_RUN_TICKETS = SIMULATE ? dryRun.loadFixtures(DRY_RUN_FIXTURE_PATH) : null;
const redmineFetch = SIMULATE ? dryRun.createFakeRedmine({ fixtures: DRY_RUN_TICKETS }) : realRedmineFetch;
const WORKSPACE = path.dirname(REPO_PATH);
const RUNS_DIR = `${REPO_PATH}/memory/runs`;
const ARCHIVE_DIR = `${RUNS_DIR}/_archive`;
// Rotação de runs antigos (scripts/cleanup-runs.js): memory/archive/<YYYY-MM>/<task-id>/
// no checkout principal. Fora do scan de inicialização, mas quem decide "este ticket já
// foi tratado" (mostRecentArchivedCommit) continua enxergando.
const ROTATED_ARCHIVE_DIR = `${REPO_PATH}/memory/archive`;
// Watcher-state.json deixou de ser fonte de verdade de idempotência (ver decision
// 2026-09-02-orquestrador-claude-codex.md) — memory/runs/<task-id>/state.json é a
// única fonte de verdade sobre em que pé uma task está. Este arquivo agora é só um
// log de observabilidade (o que o watcher despachou no último tick), reescrito do
// zero a cada tick a partir do estado real, nunca lido de volta pra decidir nada.
const STATE_FILE = `${RUNS_DIR}/watcher-state.json`;
const DRY_RUN = process.argv.includes('--dry-run');
// --health-check: não faz tick nenhum — só lê watcher-runtime.json + state.json das
// tasks e imprime o JSON de saúde na stdout (ver scripts/lib/watcher-health.js).
// Exit 0 = saudável (idle ou running normal), 1 = estado inconsistente.
const HEALTH_CHECK = process.argv.includes('--health-check');
// Sem --follow: dispara UM segmento por ticket e sai (uso normal, ex: tick
// periódico via cron) — quem despacha o próximo segmento é o próximo tick.
// Com --follow: fica preso acompanhando o Claude e, desde 2026-09-02,
// encadeia automaticamente os próximos segmentos do MESMO ticket até travar
// (bloqueado/escalado), ficar pronto pra commit, ou o binário `claude` ficar
// indisponível — só faz sentido em teste/execução manual acompanhada, nunca
// em cron (ver tick() > MAX_FOLLOW_SEGMENTS).
const FOLLOW = process.argv.includes('--follow');
// --ticket=<id>: restringe o tick a um único ticket — só pra teste manual controlado
// (validar o orquestrador contra um ticket real sem disparar agente pros outros
// pendentes). Sem a flag, comportamento inalterado: processa todos os tickets
// retornados pelo Redmine, como sempre.
const ONLY_TICKET = (() => {
    const arg = process.argv.find(a => a.startsWith('--ticket='));
    return arg ? Number(arg.split('=')[1]) : null;
})();
// --aceitar-spec=<id>[,<id>...]: registra o aceite da spec incompleta desses tickets
// (mesmo efeito de responder "aceito" no Redmine) — atalho pra quem está no terminal.
const ACCEPT_SPEC_IDS = (() => {
    const arg = process.argv.find(a => a.startsWith('--aceitar-spec='));
    return new Set(arg ? arg.split('=')[1].split(',').map(Number).filter(Boolean) : []);
})();
// --aceitar-build=<id>[,<id>...]: aceita a falha da validação de build pré-implement
// desses tickets (mesmo efeito de responder "aceito" no Redmine) — ver runPreBuildGate.
const ACCEPT_BUILD_IDS = (() => {
    const arg = process.argv.find(a => a.startsWith('--aceitar-build='));
    return new Set(arg ? arg.split('=')[1].split(',').map(Number).filter(Boolean) : []);
})();
// --aceitar-plano=<id>[,<id>...]: aceita o plano abaixo do score mínimo desses tickets
// (status plan-escalation; mesmo efeito de responder "aceito" no Redmine) — ver runPlanGate.
const ACCEPT_PLAN_IDS = (() => {
    const arg = process.argv.find(a => a.startsWith('--aceitar-plano='));
    return new Set(arg ? arg.split('=')[1].split(',').map(Number).filter(Boolean) : []);
})();

// --aceitar-churn=<id>[,<id>...]: aceita o churn de implementação desses tickets
// (status churn-escalation; mesmo efeito de responder "aceito" no Redmine) — ver runChurnGate.
const ACCEPT_CHURN_IDS = (() => {
    const arg = process.argv.find(a => a.startsWith('--aceitar-churn='));
    return new Set(arg ? arg.split('=')[1].split(',').map(Number).filter(Boolean) : []);
})();

// Tempo máximo que um nó pode ficar em status "running" antes de ser considerado
// órfão no próximo startup do watcher (ver scripts/lib/node-lease.js e
// memory/decisions/2026-09-22-recuperacao-no-orfao-watcher.md). Lido uma vez aqui e
// gravado em state.json.node_timeout_ms a cada despacho, pra detecção ser auditável.
const NODE_TIMEOUT_MS = nodeLease.resolveNodeTimeoutMs();
const NODE_LEASE_SCRIPT = path.join(__dirname, 'lib', 'node-lease.js');

// Repos irmãos que recebem a mesma branch do ticket (sem agente rodando neles) —
// ver memory/project.yaml: app-front consome a API deste backend, app-core e
// mo-entity concentram lógica compartilhada (ex: núcleo de alterarEtapa, entidades).
const SIBLING_REPOS = (process.env.WATCHER_SIBLING_REPOS || '').split(',').map(s => s.trim()).filter(Boolean);
for (const name of SIBLING_REPOS) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes('..')) throw new Error('nome de repositório irmão inválido');
}

// Mesma decisão de branch base do nó Fetch Ticket (.claude/commands/fetch-ticket.md
// passo 3) — tem que ficar em sincronia com aquele arquivo se a convenção mudar lá.
const BASE_BY_LIBERACAO = {
    'Dev - Local': 'development',
    'Master - Stage': 'master',
};

// ---------------------------------------------------------------------------------
// Grafo (.graph/graph.yaml): fetch_ticket → plan → implement → review → test →
// verify → commit. Todo nó é despachado pro Claude Code (`claude -p`) — até
// 2026-09-18 este orquestrador também sabia despachar Codex CLI como segundo
// agente (preferencial em implement/test/verify, fallback nos demais); removido a
// pedido do usuário (ver memory/decisions/2026-09-18-remocao-codex-workflow.md).
// Um "segmento" é o que um único despacho (uma única invocação de `claude -p`)
// cobre — normalmente um nó só, exceto fetch_ticket+plan (mesma aresta on_success
// sem veredito no meio, então cabem no mesmo despacho).

// Nós que o watcher nunca despacha sozinho, mesmo com o agente disponível — existia
// pra impedir commit automático ("pare antes do /commit", comportamento original).
// Removido em 2026-09-02 a pedido explícito do usuário ("quero que dispare sim o
// /commit") — ver memory/decisions/2026-09-02-commit-automatico.md. Mantido como
// mecanismo (conjunto vazio, não deletado) porque é reutilizável se algum nó futuro
// precisar do mesmo tipo de checkpoint manual.
const NEVER_AUTO_DISPATCH = new Set([]);

// ---------------------------------------------------------------------------------
// Estado de runtime do processo watcher (observabilidade + shutdown graceful). Objeto
// MUTÁVEL único: GracefulShutdown (scripts/lib/graceful-shutdown.js) recebe a
// referência uma vez e lê o snapshot na hora do SIGTERM; o health-check lê a cópia em
// disco (watcher-runtime.json). activeCycle = ciclo que ESTE processo está conduzindo
// (do lease do nó até o agente sair em --follow, ou até o spawn no modo detached —
// daí em diante o agente destacado é dono do próprio lease e sobrevive ao watcher).
// uptime/próxima poll vêm do laço do dashboard (scripts/watcher-manager.js), que passa
// WATCHER_LOOP_STARTED_AT e WATCHER_TICK_INTERVAL_MS no env de cada tick.
const WATCHER_RUNTIME_FILE = `${RUNS_DIR}/${watcherHealth.RUNTIME_FILE}`;

function createWatcherState(env = process.env) {
    const startedAt = new Date().toISOString();
    const loopStarted = Date.parse(env.WATCHER_LOOP_STARTED_AT);
    const interval = Number(env.WATCHER_TICK_INTERVAL_MS);
    return {
        pid: process.pid,
        startedAt,
        loopStartedAt: Number.isFinite(loopStarted) ? new Date(loopStarted).toISOString() : startedAt,
        tickIntervalMs: interval > 0 ? interval : null,
        status: 'idle',
        activeCycle: null,
        lastCompletedCycle: null,
        nextPollAt: null,
        shuttingDown: false,
    };
}
const watcherState = createWatcherState();

// Cópia serializável (sem o ChildProcess do agente) — gravação atômica (tmp + rename):
// o health-check pode ler a qualquer momento.
function writeWatcherRuntime(st = watcherState) {
    if (DRY_RUN || HEALTH_CHECK) return;
    const { child, ...cycle } = st.activeCycle || {};
    const { shuttingDown, ...rest } = st;
    const out = { ...rest, activeCycle: st.activeCycle ? cycle : null, updatedAt: new Date().toISOString() };
    try {
        fs.mkdirSync(path.dirname(WATCHER_RUNTIME_FILE), { recursive: true });
        const tmp = `${WATCHER_RUNTIME_FILE}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
        fs.renameSync(tmp, WATCHER_RUNTIME_FILE);
    } catch (e) {
        console.error('[runtime] falha gravando watcher-runtime.json:', e.message);
    }
}

// lastCompletedCycle sobrevive entre ticks (cada tick é um processo novo).
function loadPreviousRuntime() {
    const { runtime } = watcherHealth.readRuntime(WATCHER_RUNTIME_FILE);
    if (runtime?.lastCompletedCycle) watcherState.lastCompletedCycle = runtime.lastCompletedCycle;
}

function beginCycle({ ticketId, taskId = null, node, dir = null, leaseStartedAt = null }) {
    watcherState.activeCycle = { ticketId, taskId, node, startedAt: new Date().toISOString(), dir, leaseStartedAt, child: null };
    watcherState.status = 'running';
    writeWatcherRuntime();
}

// status: 'completed'/'failed' (--follow, agente saiu) ou 'dispatched' (agente destacado).
// No-op durante o shutdown: quem fecha o ciclo aí é o GracefulShutdown ("interrupted").
function endCycle(status) {
    if (watcherState.shuttingDown || !watcherState.activeCycle) return;
    const c = watcherState.activeCycle;
    watcherState.lastCompletedCycle = { taskId: c.taskId, ticketId: c.ticketId, node: c.node, completedAt: new Date().toISOString(), status };
    watcherState.activeCycle = null;
    watcherState.status = 'idle';
    writeWatcherRuntime();
}

function runHealthCheck() {
    const worktreesDir = `${REPO_PATH}/.claude/worktrees`;
    const runsDirs = [RUNS_DIR];
    if (fs.existsSync(worktreesDir)) {
        for (const d of fs.readdirSync(worktreesDir, { withFileTypes: true })) {
            if (d.isDirectory()) runsDirs.push(`${worktreesDir}/${d.name}/memory/runs`);
        }
    }
    const health = watcherHealth.computeHealth({ runtimePath: WATCHER_RUNTIME_FILE, runsDirs, defaultTimeoutMs: NODE_TIMEOUT_MS });
    process.stdout.write(`${JSON.stringify(health)}\n`);
    return health.healthy ? 0 : 1;
}

// Convenção de state.json.node: SEMPRE "o próximo nó a rodar", nunca "o nó que
// acabou de rodar" — isso é o que `history` registra. Todo comando (.claude/
// commands/*.md) segue essa convenção uniformemente: ao terminar, grava em `node`
// o nó seguinte da aresta (ex: fetch_ticket termina gravando node="plan"; review
// reprovado grava node="implement", igual a implement terminando com sucesso
// gravaria node="review" — mesmo nome, mesmo significado, sem ambiguidade).

function commandAvailable(bin) {
    try {
        execSync(`command -v ${bin}`, { stdio: 'pipe' });
        return true;
    } catch {
        return false;
    }
}

function loadWatcherLog() {
    return { last_tick_at: null, tickets: {} };
}

function saveWatcherLog(log) {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(log, null, 2));
}

// Só pega demanda pronta pra começar: Aprovada (trabalho novo) ou Recusa QA
// (retrabalho — nesse caso os comentários do QA explicando o que deu errado são
// buscados à parte, ver fetchQaFeedback). Nunca pega Em Desenvolvimento, Ag
// Atualização, Ag Teste etc. — não é a hora de disparar agente nesses.
const STATUS_IDS = { Aprovada: 11, 'Recusa QA': 13 };

async function fetchAssignedTickets() {
    const statusFilter = Object.values(STATUS_IDS).join('|');
    const res = await redmineFetch(
        `${REDMINE_URL}/issues.json?assigned_to_id=me&status_id=${statusFilter}&sort=created_on:desc`,
        { headers: { 'X-Redmine-API-Key': REDMINE_API_KEY } }
    );
    const data = await res.json();
    return data.issues;
}

// Busca um ticket específico por id, IGNORANDO status — usado só pra reidratar
// tickets que já têm task ativa local mas saíram de Aprovada/Recusa QA (ver
// findLocallyActiveTicketIds). fetchAssignedTickets sozinho não serve pra isso:
// ele só lista quem está esperando pra COMEÇAR.
async function fetchTicketById(id) {
    const res = await redmineFetch(
        `${REDMINE_URL}/issues/${id}.json`,
        { headers: { 'X-Redmine-API-Key': REDMINE_API_KEY } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.issue || null;
}

// Ids de ticket com task ativa (in_progress/blocked/escalated, não arquivada) em
// algum worktree já existente — descoberto direto no disco, sem depender do Redmine
// ainda listar o ticket como "esperando começar". Existe porque, desde que
// fetch_ticket passou a mover o ticket pra "Em Desenvolvimento" (2026-09-02), um
// ticket cuja task já está em andamento deixa de aparecer em
// fetchAssignedTickets() (que só pega Aprovada/Recusa QA) — sem isto, o watcher
// nunca mais re-descobriria esse ticket pra continuar o grafo depois do primeiro
// segmento. Achado ao vivo (ticket #43387: "0 tickets" depois do fetch_ticket).
function findLocallyActiveTicketIds() {
    // DRY-RUN: os tickets do fixture já vêm todo tick; reidratar tickets reais dos
    // worktrees faria o agente simulado andar com tasks de verdade.
    if (SIMULATE) return [];
    const worktreesDir = `${REPO_PATH}/.claude/worktrees`;
    if (!fs.existsSync(worktreesDir)) return [];
    const ids = fs.readdirSync(worktreesDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && /^\d+$/.test(d.name))
        .map(d => Number(d.name));
    return ids.filter(id => {
        const active = findActiveTask(id);
        return active && (active.corrupted || active.state.status !== 'committed');
    });
}

// Comentários (journals) do ticket que tenham texto — usado pra recuperar o
// motivo da recusa em tickets "Recusa QA". Mais recente primeiro.
async function fetchQaFeedback(id) {
    const res = await redmineFetch(
        `${REDMINE_URL}/issues/${id}.json?include=journals`,
        { headers: { 'X-Redmine-API-Key': REDMINE_API_KEY } }
    );
    const data = await res.json();
    // Comentários do próprio watcher ([Watcher] ...: pendência de spec, bloqueio etc.)
    // não são feedback do QA — sem este filtro iam pro prompt como "motivo da recusa".
    const journals = (data.issue?.journals || [])
        .filter(j => j.notes && j.notes.trim() && !specValidator.isWatcherNote(j.notes));
    return journals.reverse().map(j => `- ${j.user?.name || '?'} (${j.created_on}): ${j.notes.trim()}`);
}

// ---------------------------------------------------------------------------------
// Recusa QA com retry pelo dashboard (botão "Corrigir recusa QA", POST
// /api/runs/:taskId/retry-qa-rejection). O polling grava ticket_status (+ qa_rejection
// ao entrar em Recusa QA) no run mais recente do ticket — ativo ou arquivado, inclusive
// o copiado pro _archive do checkout principal quando o merge apagou o worktree. Ticket
// em Recusa QA que já tem run anterior NÃO abre ciclo novo sozinho: espera o botão, que
// reaproveita o mesmo task-id (WATCHER_RECUSA_QA_NOVO_CICLO=1 volta ao comportamento
// antigo). O botão deixa retry-signal.json no run; consumeQaRetrySignals o traz de
// volta pro worktree e o tick despacha o implement.
const QA_AUTO_NEW_CYCLE = /^(1|true|sim)$/i.test(process.env.WATCHER_RECUSA_QA_NOVO_CICLO || '');
const QA_RETRY_SIGNAL = 'retry-signal.json';
const qaRetryTasks = new Set(); // task-ids cujo sinal foi consumido neste processo (nota no prompt)

// Diretórios onde um run do ticket pode estar: ativo/arquivado no worktree, e o
// checkout principal (runs/ e _archive/). A rotação (memory/archive/) fica de fora de
// propósito: o dashboard não lista esses runs, então uma Recusa QA esperaria para
// sempre por um "Corrigir recusa QA" que ninguém consegue clicar — sem run anterior,
// o ciclo novo abre sozinho.
function ticketRunRoots(ticketId) {
    return [taskRunsDir(ticketId), taskArchiveDir(ticketId), RUNS_DIR, ARCHIVE_DIR];
}

function rotatedArchiveDirs() {
    try {
        return fs.readdirSync(ROTATED_ARCHIVE_DIR, { withFileTypes: true })
            .filter(d => d.isDirectory() && /^\d{4}-\d{2}$/.test(d.name))
            .map(d => `${ROTATED_ARCHIVE_DIR}/${d.name}`);
    } catch {
        return [];
    }
}

// Run mais recente (por updated_at) do ticket em qualquer um desses lugares.
function latestRunForTicket(ticketId) {
    let best = null;
    for (const root of ticketRunRoots(ticketId)) {
        for (const name of listTaskDirs(root, ticketId)) {
            const dir = `${root}/${name}`;
            const check = readStateChecked(dir);
            const state = check.state || check.raw;
            if (!state || typeof state !== 'object') continue;
            const t = new Date(state.updated_at || state.started_at || 0).getTime() || 0;
            if (!best || t > best.t) best = { taskId: name, dir, state, t, valid: check.valid };
        }
    }
    return best;
}

// Grava a mudança de status do ticket no run mais recente. Não mexe em updated_at
// (decide findActiveTask/mostRecentArchivedCommit) nem em run com nó rodando (o agente
// reescreve o state.json ao sair — fica pro próximo tick).
async function syncQaRejection(ticket) {
    const name = ticket.status?.name;
    if (!name) return null;
    const latest = latestRunForTicket(ticket.id);
    if (!latest || latest.state.status === 'running' || latest.state.ticket_status === name) return latest;
    const next = { ...latest.state, ticket_status: name };
    if (qaJournal.isQaRejectedStatus(name)) {
        const found = await qaJournal.fetchLastRejectionNote(ticket.id);
        const rejection = {
            note: found?.note ?? null,
            rejected_at: found?.rejected_at || ticket.updated_on || new Date().toISOString(),
            journal_id: found?.journal_id ?? null,
        };
        // Histórico por recusa ANTES de trocar o qa_rejection: o anterior (com
        // retry_requested_at) é o que diz quando o último retry começou em run antigo.
        let contextMd = '';
        try { contextMd = fs.readFileSync(`${latest.dir}/context.md`, 'utf8'); } catch { /* sem context.md */ }
        next.qa_rejections = qaCycles.recordRejection(latest.state, contextMd, { ...rejection, at: new Date().toISOString() });
        next.qa_rejection = rejection;
        console.log(`Ticket #${ticket.id}: Recusa QA detectada — gravada em ${latest.taskId} (retry pelo botão "Corrigir recusa QA" do dashboard).`);
    }
    if (DRY_RUN) return { ...latest, state: next };
    stateWriter.write(latest.dir, next, { operation: 'qa_rejection_detected', actor: 'watcher', base: baseOf(latest.state) });
    if (latest.valid) checkWrittenState(latest.dir);
    return { ...latest, state: next };
}

// Sinais de retry deixados pelo dashboard. Pra cada um: garante o worktree do ticket
// (o merge pode tê-lo apagado), move o run pra <worktree>/memory/runs/<task-id> se ele
// estiver em outro lugar (_archive, checkout principal), confere node=implement /
// status=in_progress, remove o sinal e devolve os ids de ticket pro tick despachar.
// Problema com um sinal (ticket sumiu, sem base, destino ocupado) mantém o arquivo —
// tenta de novo no próximo tick.
async function consumeQaRetrySignals() {
    if (SIMULATE) return []; // sinais do dashboard são de runs reais — DRY-RUN não consome
    const roots = [RUNS_DIR, ARCHIVE_DIR];
    const worktreesDir = `${REPO_PATH}/.claude/worktrees`;
    if (fs.existsSync(worktreesDir)) {
        for (const d of fs.readdirSync(worktreesDir, { withFileTypes: true })) {
            if (d.isDirectory()) roots.push(`${worktreesDir}/${d.name}/memory/runs`, `${worktreesDir}/${d.name}/memory/runs/_archive`);
        }
    }
    const ids = new Set();
    for (const root of roots) {
        let entries = [];
        try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
        for (const d of entries) {
            if (!d.isDirectory() || d.name.startsWith('_')) continue;
            const dir = `${root}/${d.name}`;
            if (!fs.existsSync(`${dir}/${QA_RETRY_SIGNAL}`)) continue;
            try {
                const id = await consumeQaRetrySignal(dir);
                if (id) ids.add(id);
            } catch (e) {
                console.error(`[qa-retry] ${dir}: falha consumindo ${QA_RETRY_SIGNAL} (fica pro próximo tick):`, e.message);
            }
        }
    }
    return [...ids];
}

async function consumeQaRetrySignal(dir) {
    const taskId = path.basename(dir);
    const check = readStateChecked(dir);
    const state = check.state || check.raw;
    const ticketId = Number(ticketIdOfTask(taskId, state));
    if (!ticketId) {
        console.warn(`[qa-retry] ${taskId}: sinal de retry em run sem ticket numérico — ignorado.`);
        return null;
    }
    if (ONLY_TICKET && ticketId !== ONLY_TICKET) return null;
    if (DRY_RUN) {
        console.log(`[dry-run] [qa-retry] ${taskId}: traria o run pro worktree do #${ticketId} e despacharia o implement.`);
        return null;
    }
    const target = `${taskRunsDir(ticketId)}/${taskId}`;
    if (path.resolve(dir) !== path.resolve(target)) {
        const ticket = await fetchTicketById(ticketId);
        if (!ticket) { console.warn(`[qa-retry] ${taskId}: ticket #${ticketId} não encontrado no Redmine — sinal mantido.`); return null; }
        const base = BASE_BY_LIBERACAO[branchLiberacao(ticket)];
        if (!base) { console.warn(`[qa-retry] ${taskId}: "Branch Liberação" do #${ticketId} ausente/não reconhecida — sinal mantido.`); return null; }
        for (const repo of SIBLING_REPOS) {
            const repoPath = `${WORKSPACE}/${repo}`;
            if (!fs.existsSync(repoPath)) continue;
            try { ensureTicketWorktree(repoPath, ticketId, base); } catch (e) { console.error(`[qa-retry] falha criando worktree #${ticketId} em ${repo}:`, e.message); }
        }
        if (!ensureTicketWorktree(REPO_PATH, ticketId, base)) {
            console.warn(`[qa-retry] ${taskId}: sem worktree do #${ticketId} — sinal mantido.`);
            return null;
        }
        if (fs.existsSync(target)) {
            console.error(`[qa-retry] ${taskId}: já existe ${target} — não sobrescrevo; resolva manualmente (sinal mantido em ${dir}).`);
            return null;
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        try {
            fs.renameSync(dir, target);
        } catch (e) {
            if (e.code !== 'EXDEV') throw e;
            fs.cpSync(dir, target, { recursive: true });
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
    const fresh = readStateJson(target) || state;
    // Carimbo da limpeza pós-PR é do ciclo anterior: o próximo /commit tem que limpar de novo.
    if (fresh.node !== 'implement' || fresh.status !== 'in_progress' || fresh.worktrees_removed_on_pr_open_at) {
        const { worktrees_removed_on_pr_open_at: _cleaned, ...reopened } = fresh;
        stateWriter.write(target, { ...reopened, node: 'implement', status: 'in_progress' }, { operation: 'qa_retry_reopen', actor: 'watcher', base: baseOf(fresh) });
        checkWrittenState(target);
    }
    // O /commit do ciclo anterior é autorizado a escrever na spec (notas de correção
    // datadas): o retry parte da spec atual como baseline, não do hash do Plan antigo.
    rebaselineSpecForQaRetry(target, taskId);
    fs.rmSync(`${target}/${QA_RETRY_SIGNAL}`, { force: true });
    qaRetryTasks.add(taskId);
    console.log(`[qa-retry] ${taskId}: retry de Recusa QA #${fresh.qa_retry_count || 1} — run em ${path.relative(REPO_PATH, target)}, implement a despachar.`);
    return ticketId;
}

function rebaselineSpecForQaRetry(dir, taskId) {
    try {
        const s = readStateJson(dir);
        if (!s) return;
        const root = path.resolve(dir, '..', '..', '..');
        const rel = specAuthority.specRelFor(s, taskId);
        const probe = specAuthority.baselineFields(root, rel, 'qa_retry', undefined, s);
        if (!probe || probe.spec_hash === s.spec_hash) return;
        // applyBaseline: run versionado registra o hash novo como rebaseline da mesma
        // spec_version (nota de correção do /commit não é SPEC_CHANGE — versão não sobe).
        const { spec_drift: _drift, ...next } = s;
        const fields = specAuthority.applyBaseline(next, {
            root, specPath: rel, by: 'qa_retry', taskId,
            reason: 'retry de Recusa QA: spec pós-/commit (notas de correção) vira o baseline — versão mantida',
        });
        const at = fields.spec_hash_at;
        next.events = [...(Array.isArray(next.events) ? next.events : []), {
            type: 'spec_baseline', node: 'implement', ts: at, at,
            detail: `retry de Recusa QA: spec_hash ${fields.spec_hash.slice(0, 12)} de ${fields.spec_path} (spec pós-/commit) vira o baseline`,
        }];
        stateWriter.write(dir, { ...next, updated_at: at }, { operation: 'qa_retry_rebaseline', actor: 'watcher', base: baseOf(s) });
        checkWrittenState(dir);
    } catch (e) {
        console.error(`[qa-retry] ${taskId}: falha regravando spec_hash (o portão de drift grava no próximo tick):`, e.message);
    }
}

function qaRetryNote(taskId, node) {
    if (node !== 'implement' || !qaRetryTasks.has(taskId)) return '';
    qaRetryTasks.delete(taskId);
    return ` Este implement é um RETRY de Recusa QA: leia a última seção "## Recusa QA — Correção Solicitada" no fim de memory/runs/${taskId}/context.md e corrija exatamente o que o QA apontou, aproveitando o contexto do ciclo anterior (não recomece do zero).`;
}

function branchLiberacao(ticket) {
    const field = (ticket.custom_fields || []).find(f => f.name === 'Branch Liberação');
    return field ? field.value : null;
}

function worktreePathFor(repoPath, id) {
    // DRY-RUN: sem worktree git (criar um exige `git fetch origin`) — o ticket fictício
    // "mora" no checkout principal, então o run fica em memory/runs/<task-id>/.
    if (SIMULATE) return repoPath;
    return `${repoPath}/.claude/worktrees/${id}`;
}

// Cria (se não existir) um worktree na branch `id`, a partir de origin/base — mesma
// convenção usada hoje nos 4 repos (branch nomeada só com o número do ticket).
function localBranchExists(repoPath, id) {
    try {
        execSync(`git -C ${repoPath} rev-parse --verify --quiet refs/heads/${id}`, { stdio: 'pipe' });
        return true;
    } catch {
        return false;
    }
}

// null de volta = não deu pra criar (branch já existe em outro checkout, ex: o
// checkout principal do repo, como acontece com o ticket em andamento agora).
// true se `id` está de fato anexada a algum worktree vivo agora (checkout principal
// ou outro worktree) — diferente de "a branch existe", que localBranchExists já
// checa. Um worktree cujo diretório foi apagado sem `git worktree remove` (fica
// "prunable") não conta: `git worktree list --porcelain` só lista entradas que o
// próprio git ainda considera registradas, prunable ou não, então filtramos as que
// realmente têm diretório no disco.
function branchCheckedOutElsewhere(repoPath, id) {
    const out = execSync(`git -C ${repoPath} worktree list --porcelain`, { encoding: 'utf8' });
    const entries = out.split('\n\n').filter(Boolean);
    for (const entry of entries) {
        const wtLine = entry.split('\n').find(l => l.startsWith('worktree '));
        const branchLine = entry.split('\n').find(l => l.startsWith('branch '));
        if (!wtLine || !branchLine) continue;
        const wtPath = wtLine.slice('worktree '.length);
        const branch = branchLine.slice('branch refs/heads/'.length);
        if (branch === id && fs.existsSync(wtPath)) return true;
    }
    return false;
}

// memory/ é local (gitignored, fora do índice), então um worktree novo nasce sem ela.
// Liga por symlink as partes compartilhadas (project.yaml, spec/,
// decisions/...) à cópia do checkout principal; runs/ fica como diretório próprio
// do worktree, porque é contexto de trabalho por ticket. Repos irmãos sem memory/
// não são afetados.
function linkLocalMemory(repoPath, worktreePath) {
    const src = `${repoPath}/memory`;
    if (!fs.existsSync(src)) return;
    const dst = `${worktreePath}/memory`;
    fs.mkdirSync(`${dst}/runs`, { recursive: true });
    for (const name of fs.readdirSync(src)) {
        if (name === 'runs' || name === '.DS_Store') continue;
        const target = `${dst}/${name}`;
        try {
            fs.lstatSync(target);
            continue; // já existe (arquivo, pasta ou link) — não sobrescreve
        } catch {}
        fs.symlinkSync(`${src}/${name}`, target);
    }
}

function ensureTicketWorktree(repoPath, id, base) {
    const worktreePath = worktreePathFor(repoPath, id);
    if (fs.existsSync(worktreePath)) return worktreePath;

    if (localBranchExists(repoPath, id)) {
        if (branchCheckedOutElsewhere(repoPath, id)) {
            console.warn(
                `${repoPath}: branch ${id} já está checked out em outro worktree/no ` +
                `checkout principal — não crio outro worktree, pulando.`
            );
            return null;
        }
        // Branch existe mas não está anexada a nenhum worktree vivo agora (ex: o
        // diretório de um worktree anterior foi apagado sem `git worktree remove` —
        // rode `git worktree prune` pra limpar o registro órfão antes disso). Reusa a
        // branch existente em vez de tentar recriá-la (git recusaria `-b` num branch
        // que já existe).
        console.log(`${repoPath}: branch ${id} já existe mas está livre — anexando a um worktree novo em vez de recriar.`);
        execSync(`git -C ${repoPath} worktree add ${worktreePath} ${id}`, { stdio: 'inherit' });
        linkLocalMemory(repoPath, worktreePath);
        return worktreePath;
    }

    execSync(`git -C ${repoPath} fetch origin ${base}`, { stdio: 'inherit' });
    execSync(`git -C ${repoPath} worktree add ${worktreePath} -b ${id} origin/${base}`, { stdio: 'inherit' });
    linkLocalMemory(repoPath, worktreePath);
    return worktreePath;
}

// ---------------------------------------------------------------------------------
// Descoberta de estado de task a partir do sistema de arquivos, que é a única fonte
// de verdade. Task-ids de tickets do watcher sempre começam com "<ticket-id>-"
// (formato gerado por .claude/commands/fetch-ticket.md passo 6).
//
// IMPORTANTE: memory/runs/<task-id>/ vive dentro do WORKTREE do ticket
// (.claude/worktrees/<ticket-id>/memory/runs/), não em REPO_PATH — worktrees git têm
// diretório de trabalho totalmente independente, inclusive pra arquivos versionados
// (um worktree não vê o que outro escreveu até commitar E dar merge). fetch_ticket e
// plan rodam com cwd = worktree, então é lá que state.json/context.md/handoff.md
// realmente ficam. Ler do REPO_PATH (checkout principal) aqui faria o watcher nunca
// achar a task ativa e redespachar fetch_ticket pra sempre — bug real encontrado e
// corrigido durante a validação com ticket real (ver decision desta evolução).
// RUNS_DIR/ARCHIVE_DIR (globais, em REPO_PATH) continuam servindo só pro que é do
// próprio orquestrador: watcher-state.json e os .log de acompanhamento.

function taskRunsDir(ticketId) {
    return `${worktreePathFor(REPO_PATH, ticketId)}/memory/runs`;
}

function taskArchiveDir(ticketId) {
    return `${taskRunsDir(ticketId)}/_archive`;
}

function listTaskDirs(baseDir, ticketId) {
    if (!fs.existsSync(baseDir)) return [];
    const prefix = `${ticketId}-`;
    return fs.readdirSync(baseDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name.startsWith(prefix))
        .map(d => d.name);
}

// Toda leitura de state.json passa por scripts/validate-state.js (schema em
// .graph/schemas/state.schema.json). O nome do diretório da task É o task-id.
// Devolve o resultado completo ({valid, state, errors, reason, raw}) — quem chama
// decide o que fazer com state inválido (ver findActiveTask/handleCorruptedState).
function readStateChecked(dir) {
    const check = readAndValidateState(path.basename(dir), { dir });
    if (check.state) rememberBase(check.state);
    return check;
}

// Leitura-base de cada state lido pelo watcher: as escritas passam a base para o
// state-writer, que só recusa (STATE_CONFLICT) quando outro processo mudou um campo
// crítico de que o watcher discorda — o resto é reaplicado sobre o disco fresco.
const readBases = new WeakMap();
function rememberBase(state) {
    if (state && typeof state === 'object') readBases.set(state, structuredClone(state));
    return state;
}
function baseOf(state) {
    return (state && readBases.get(state)) || null;
}

function readStateJson(dir) {
    return readStateChecked(dir).state;
}

// Depois de TODA escrita de state.json feita pelo watcher: revalida o que ficou no
// disco. Só loga — a escrita já aconteceu, e escalar aqui por um bug do próprio
// watcher esconderia o problema atrás de um state_corrupted.
function checkWrittenState(dir) {
    const check = readStateChecked(dir);
    if (!check.valid) {
        console.error(`[state-error] Escrita resultou em state inválido em ${dir}/state.json: ${check.errors.join('; ')}`);
    }
}

// Task ativa = existe <worktree>/memory/runs/<ticket>-*/ (não arquivada). Se houver
// mais de uma (não deveria, mas não confia cegamente), pega a mais recentemente
// atualizada. Se o worktree do ticket ainda nem existe, não há task ativa — comportamento
// correto (ticket nunca visto antes).
//
// Task dir com state.json inválido (JSON malformado ou fora do schema) tem PRIORIDADE
// sobre as válidas e volta como { taskId, dir, state: null, corrupted: true, check }:
// antes ela era só pulada — e se fosse a única, o watcher concluía "sem task ativa" e
// redespachava fetch_ticket por cima de uma task em andamento. Como não dá pra saber
// se a corrompida é mais recente que as outras, quem decide é o humano.
// Dir sem state.json nenhum continua ignorado, como antes.
function findActiveTask(ticketId) {
    const runsDir = taskRunsDir(ticketId);
    const names = listTaskDirs(runsDir, ticketId);
    let best = null;
    for (const name of names) {
        const dir = `${runsDir}/${name}`;
        const check = readStateChecked(dir);
        if (!check.valid) {
            if (check.reason === 'missing') continue;
            return { taskId: name, dir, state: null, corrupted: true, check };
        }
        const state = check.state;
        // Run parado que já foi retomado por um replay (scripts/lib/cycle-replayer.js):
        // quem responde pelo ticket agora é o replay — sem isto, arquivado o replay, o
        // original voltaria a ser "a task ativa" e a notificar bloqueio.
        if (!['in_progress', 'running'].includes(state.status) && cycleReplayer.supersededBy(dir)) continue;
        const updated = new Date(state.updated_at || state.started_at || 0).getTime();
        if (!best || updated > best.updated) best = { taskId: name, dir, state, updated };
    }
    return best;
}

// Maior updated_at entre as tasks já arquivadas (commitadas) deste ticket, dentro do
// próprio worktree — usado pra distinguir "este ciclo Aprovada/Recusa QA já foi
// tratado" de "isto é um ciclo novo" sem precisar de nenhum cache paralelo: compara
// contra o updated_on que o próprio Redmine reporta pro ticket. Inclui o que a rotação
// (scripts/cleanup-runs.js) já tirou do _archive pra memory/archive/<YYYY-MM>/ — sem
// isso, um ticket entregue há mais de RUNS_RETENTION_DAYS seria redespachado.
function mostRecentArchivedCommit(ticketId) {
    let max = null;
    for (const archiveDir of [taskArchiveDir(ticketId), ...rotatedArchiveDirs()]) for (const name of listTaskDirs(archiveDir, ticketId)) {
        // Arquivada = task já commitada: histórico, nunca marcada como state_corrupted.
        // Fora do schema ainda serve pra ler updated_at (tolerante, como antes da
        // validação) — ignorá-la faria o watcher achar que o ciclo não foi tratado e
        // redespachar um ticket já entregue. O erro fica logado pelo validador.
        const check = readStateChecked(`${archiveDir}/${name}`);
        const state = check.state || check.raw;
        if (!state || !state.updated_at) continue;
        const t = new Date(state.updated_at).getTime();
        if (!max || t > max) max = t;
    }
    return max;
}

// ---------------------------------------------------------------------------------
// Notificação assíncrona de bloqueio/escalonamento. `claude -p` é single-turn
// (roda e sai) e o watcher fecha o stdin de propósito no spawn (ver spawnAgent),
// então não existe canal pra "perguntar e esperar resposta" durante um segmento
// despachado sem supervisão (cron, ou --follow sem ninguém olhando o terminal). O
// grafo já modela isso com status "blocked"/"escalated" em state.json
// (dispatchTicket já para de redespachar esses), mas até aqui isso era silencioso
// — achado ao vivo: o ticket #43293 ficou blocked 6 dias sem ninguém notar, só
// descoberto vasculhando o worktree manualmente. Isto não reabre interatividade
// (impossível sem mudar como o agente é invocado) — só avisa que HÁ uma
// pergunta/bloqueio esperando resposta assíncrona (editando context.md/handoff.md
// do worktree, ou comentando no próprio ticket), pro próximo tick retomar sozinho
// depois.

function notifiedMarkerPath(dir) {
    return `${dir}/.watcher-notified.json`;
}

// Assinatura = nó+status atual. Só renotifica se isto mudar (ex: destravou e travou
// nele de novo por outro motivo) — sem isto, todo tick comentaria no Redmine de novo
// pro mesmo bloqueio, spam real considerando que tick roda em cron.
// markerPath é o arquivo de marcação em si (não um diretório) — quem chama decide
// onde ele mora (notifyBlocked usa notifiedMarkerPath(dir) dentro da task;
// notifyPretaskBlocked usa pretaskNotifiedMarkerPath(ticketId) em RUNS_DIR, já que
// pré-task não tem task dir ainda).
function alreadyNotified(markerPath, signature) {
    if (!fs.existsSync(markerPath)) return false;
    try {
        return JSON.parse(fs.readFileSync(markerPath, 'utf8')).signature === signature;
    } catch {
        return false;
    }
}

function markNotified(markerPath, signature) {
    fs.writeFileSync(markerPath, JSON.stringify({ signature, notified_at: new Date().toISOString() }, null, 2));
}

// Nota mais recente de agent_log (ver .graph/schemas/state.schema.json > agent_log[].note)
// — é onde implement.md/verify.md etc. instruem o agente a registrar o motivo real do
// bloqueio; não é um campo dedicado em state.json (schema não tem um).
function lastAgentNote(state) {
    const log = state.agent_log || [];
    for (let i = log.length - 1; i >= 0; i--) {
        if (log[i].note) return log[i].note;
    }
    return null;
}

// Instrução extra pro despacho do nó `commit` a partir de state.json.risk_level
// (gravado pelo /verify, passo 4). Não muda o fluxo de dispatch — commit continua
// automático pra high e low —, só como o PR é aberto no Bitbucket. Quem chama
// bitbucket-open-pr.sh é o agente seguindo commit.md passo 7, então é por aqui
// (prompt do despacho) que o watcher fixa o modo do PR com o valor que ELE leu do
// state.json, em vez de depender só do agente reler o campo. "low"/ausente
// (tasks anteriores a 2026-09-22) => string vazia, prompt idêntico ao de antes.
// Ver memory/decisions/2026-09-22-pr-draft-high-risk.md.
function commitRiskNote(state) {
    if (state?.risk_level !== 'high') return '';
    const reason = state.risk_reason || '(Verify não registrou risk_reason — ver context.md)';
    return (
        `ATENÇÃO — state.json.risk_level = "high" (motivo: ${reason}). No passo 7 do /commit, ` +
        `abra TODO PR desta task (consumidor e repos irmãos) com ` +
        `\`scripts/bitbucket-open-pr.sh --draft --title-prefix "HIGH-RISK" ...\` e comece a ` +
        `descrição com o bloco de aviso HIGH-RISK de commit.md passo 7, com "Motivo:" = ` +
        `o risk_reason acima, literal. Todo o resto do /commit segue igual.`
    );
}

// ---------------------------------------------------------------------------------
// Canal humano→agente (dashboard/server.js). O dashboard só APPENDA mensagens em
// <task dir>/human-input.md; quem consome é o watcher, aqui, logo antes de cada
// despacho de segmento — ou seja, entre dois nós consecutivos (em --follow, entre
// cada segmento encadeado; sem --follow, a cada tick). Best-effort: se o watcher
// morrer antes de consumir, o arquivo fica lá e é lido no próximo despacho.
//
// Sequência pensada pra corrida com o dashboard: renomeia PRIMEIRO pra um nome
// único (atômico no mesmo fs) e só depois lê — uma mensagem que chegue entre o
// rename e a leitura cai num human-input.md novo e fica pro próximo despacho, em
// vez de ser movida pra processado sem nunca ter sido injetada. Sobra de um crash
// no meio (*.processing) é reaproveitada na próxima chamada.
// Devolve o texto consumido (ou null) — quem chama também injeta no prompt do
// despacho, porque /plan reescreve context.md e poderia apagar o append.
// Lança em vez de devolver {} quando o state.json existe mas é inválido — devolver {}
// fazia writeTaskState sobrescrever o arquivo inteiro só com human_inputs.
// checkHumanInput roda dentro de try/catch em dispatchTicket (fica pro próximo despacho).
// Evento estruturado em state.json.events da task (ver lib/node-events.js). Nunca
// lança — falha só é logada. `dir` opcional quando o caller já o tem.
function appendEvent(taskId, event, dir = `${taskRunsDir(String(taskId).split('-')[0])}/${taskId}`) {
    return nodeEvents.appendEvent(dir, event);
}

function readTaskState(dir) {
    const check = readStateChecked(dir);
    if (check.valid) return check.state;
    if (check.reason === 'missing') return {};
    throw new Error(`state.json inválido — ${check.errors.join('; ')}`);
}

// Objeto inteiro pelo state-writer: lido antes e com campo crítico divergente do disco
// (outro processo avançou o run) → STATE_CONFLICT em vez de desfazer a transição alheia.
function writeTaskState(dir, state, operation = 'watcher_write') {
    stateWriter.write(dir, state, { operation, actor: 'watcher', base: baseOf(state) });
    rememberBase(state);
    checkWrittenState(dir);
}

function checkHumanInput(dir) {
    const inputPath = `${dir}/human-input.md`;
    const leftovers = fs.existsSync(dir)
        ? fs.readdirSync(dir).filter(f => /^human-input\.\d+\.processing$/.test(f)).sort().map(f => `${dir}/${f}`)
        : [];
    if (fs.existsSync(inputPath)) {
        const processingPath = `${dir}/human-input.${Date.now()}.processing`;
        fs.renameSync(inputPath, processingPath);
        leftovers.push(processingPath);
    }
    if (leftovers.length === 0) return null;

    const content = leftovers.map(p => fs.readFileSync(p, 'utf8').trim()).filter(Boolean).join('\n\n');
    let duplicate = false;
    if (content) {
        // Idempotência (scripts/cas.js): operation_id = message_hash da interação (cada
        // mensagem do dashboard leva o próprio carimbo de hora). Crash entre gravar o
        // state e apagar o *.processing não injeta a mesma mensagem duas vezes.
        const current = readTaskState(dir);
        const res = cas.transact({
            runDir: dir, operation: 'human_input', actor: 'watcher',
            operation_id: `human_input:${humanInputIntent.messageHash(content)}`,
            expected_state_version: cas.effectiveVersion(current),
        }, s => {
            s.human_inputs = [...(s.human_inputs || []), { timestamp: new Date().toISOString(), content }];
        });
        duplicate = res.status === 'already_processed';
        checkWrittenState(dir);
        if (!duplicate) {
            fs.appendFileSync(`${dir}/context.md`, `\n\n---\n${content}\n---\n`);
            fs.appendFileSync(`${dir}/human-input.processed.md`, `${content}\n\n`);
        }
    }
    for (const p of leftovers) fs.unlinkSync(p);

    if (duplicate) console.log(`[watcher] Human input de ${path.basename(dir)} já processado (already_processed) — não reinjetado.`);
    if (!content || duplicate) return null;
    console.log(`[watcher] Human input recebido e injetado no contexto de ${path.basename(dir)}`);
    return content;
}

// unblock = entrada de state.human_input_interpretations que destravou a task (ver
// interpretBlockedHumanInput) — o agente recebe também o que o watcher entendeu.
function humanInputNote(content, unblock = null) {
    if (!content) return '';
    return (
        ` O desenvolvedor enviou instruções pelo dashboard durante este ciclo (já anexadas ao ` +
        `final do context.md da task e registradas em state.json.human_inputs). Leve-as em ` +
        `conta neste nó e preserve esse trecho do context.md se reescrever o arquivo:\n${content}\n` +
        (unblock
            ? ` A task estava "${unblock.from_status}" no nó "${unblock.from_node}" e foi retomada por causa dessa mensagem. ` +
              `O orquestrador entendeu: ${unblock.understood}` +
              (unblock.instructions ? ` Orientação para este nó: ${unblock.instructions}` : '') +
              ` Se, ao começar, a situação não bater com isso (ex.: o bloqueio continua), grave ` +
              `status="blocked" de novo com o motivo em vez de improvisar.\n`
            : '')
    );
}

// Mensagem pendente sem consumir (human-input.md + sobras *.processing) — o intérprete
// de task blocked lê daqui; quem consome continua sendo checkHumanInput, no despacho.
function peekHumanInput(dir) {
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir).filter(f => /^human-input\.\d+\.processing$/.test(f)).sort();
    if (fs.existsSync(`${dir}/human-input.md`)) files.push('human-input.md');
    const content = files.map(f => fs.readFileSync(`${dir}/${f}`, 'utf8').trim()).filter(Boolean).join('\n\n');
    return content || null;
}

// Status que uma mensagem do dashboard pode destravar (sempre via interpretação).
// spec-change-rejected: a SPEC_CHANGE foi recusada e a spec não muda; retomar é
// implementar a spec como está (padrão: o nó implement em que parou).
// needs_human_review (commit órfão) e state_corrupted continuam só manuais.
const HUMAN_INPUT_RESUMABLE_STATUSES = new Set(['blocked', 'escalated', specChange.REJECTED_STATUS]);

// Motivo da parada que o intérprete recebe. spec-change-rejected não tem blocked_reason:
// o contexto é a proposta recusada.
function humanInputBlockedReason(state) {
    if (state.status !== specChange.REJECTED_STATUS) return state.blocked_reason;
    const r = state.spec_change_rejected || {};
    return `O /implement propôs a SPEC_CHANGE ${r.id || '?'} e um humano a REJEITOU${r.rejector ? ` (${r.rejector})` : ''}: ` +
        `a spec não muda. Proposta recusada: ${r.proposed_behavior || r.description || '(sem descrição)'}\n` +
        'Retomar significa implementar a spec como está, levando em conta o que o desenvolvedor disser ' +
        '(ex.: fazer só a parte que cabe na spec). Se ele insistir na mudança recusada, é "hold": isso exige nova SPEC_CHANGE.';
}

// Task "blocked"/"escalated"/"spec-change-rejected" com mensagem pendente do dashboard: interpreta ANTES de destravar
// (scripts/lib/human-input-intent.js). Retoma (status in_progress, node decidido) só se
// a intenção for clara; senão grava o que entendeu, responde ao dev e deixa a mensagem
// na fila — a próxima resposta dele é interpretada junto. A mesma mensagem não é
// reinterpretada a cada tick (message_hash). Falha do intérprete não muda nada: tenta
// de novo no próximo tick.
async function interpretBlockedHumanInput(ticket, active) {
    const { taskId, state, dir } = active;
    // Expectativa CAS antes do await do intérprete: retomar com base nesta leitura.
    const snap = cas.snapshotOf(state);
    const message = peekHumanInput(dir);
    if (!message) return { resumed: false };
    const hash = humanInputIntent.messageHash(message);
    const previousEntries = Array.isArray(state.human_input_interpretations) ? state.human_input_interpretations : [];
    const last = previousEntries.at(-1);
    if (last && last.message_hash === hash && last.action !== 'resume') return { resumed: false, entry: last, cached: true };

    let handoff = '';
    try { handoff = fs.readFileSync(`${dir}/handoff.md`, 'utf8'); } catch { /* sem handoff */ }
    const config = humanInputIntent.resolveConfig();
    // node "escalated" (escalada por max_retries em versões antigas) não é nó: usa o último executado.
    const fromNode = state.node === 'escalated' ? (state.history || []).at(-1) || 'plan' : state.node;
    console.log(`Task ${taskId}: mensagem do dashboard com a task ${state.status} — interpretando antes de retomar (${config.model}).`);
    const run = await humanInputIntent.interpret({
        message, status: state.status, node: fromNode, history: state.history || [], blockedReason: humanInputBlockedReason(state),
        agentNote: lastAgentNote(state), handoff, previous: last && last.action !== 'resume' ? last : null,
    }, { env: cleanAgentEnv(), config });
    if (!run.ok) {
        console.warn(`Task ${taskId}: não consegui interpretar a mensagem (${run.error}) — task continua ${state.status}, tento no próximo tick.`);
        logRun(ticket.id, '[watcher]', `interpretação da mensagem falhou: ${run.error}`);
        return { resumed: false, error: run.error };
    }

    const interp = run.interpretation;
    const decision = humanInputIntent.decide(interp, config);
    const at = new Date().toISOString();
    const entry = {
        at, message_hash: hash, from_status: state.status, from_node: fromNode, model: run.model,
        intent: interp.intent, node: interp.node, confidence: interp.confidence,
        understood: interp.understood, instructions: interp.instructions, question: interp.question,
        action: decision.action, reply: decision.reply, cost_usd: interp.cost_usd,
    };
    const applyDecision = s => {
        s.human_input_interpretations = [...(Array.isArray(s.human_input_interpretations) ? s.human_input_interpretations : []), entry];
        if (decision.action !== 'resume') return;
        s.unblocked = { at, by: 'human_input', from_status: s.status, from_node: fromNode, blocked_reason: s.blocked_reason ?? null };
        // Escalada costuma vir de max_retries: o humano autorizou nova rodada, então o
        // contador do nó que escalou recomeça (o valor antigo fica em unblocked).
        if (s.status === 'escalated' && s.retries && Number(s.retries[fromNode]) > 0) {
            s.unblocked.retries_before = { [fromNode]: s.retries[fromNode] };
            s.retries = { ...s.retries, [fromNode]: 0 };
        }
        Object.assign(s, { status: 'in_progress', node: decision.node, updated_at: at });
        delete s.blocked_reason;
    };
    try {
        if (decision.action === 'resume') {
            // Consumo humano (scripts/cas.js): idempotente pela mensagem e CAS contra a
            // leitura de antes do intérprete — se o run andou, nada é retomado.
            const res = cas.transact({
                runDir: dir, operation: 'human_input', actor: 'watcher',
                operation_id: `human_input_resume:${hash}`, expected_state_version: snap.expected_state_version,
            }, applyDecision);
            if (res.status === 'already_processed') {
                console.log(`Task ${taskId}: mensagem do dashboard já retomou a task antes (already_processed) — nada a aplicar.`);
                return { resumed: false, cached: true };
            }
        } else {
            stateWriter.update(dir, applyDecision, { operation: 'human_input_interpretation', actor: 'watcher' });
        }
    } catch (e) {
        if (!cas.isConflict(e)) throw e;
        console.warn(`Task ${taskId}: ${e.message} — o run mudou enquanto a mensagem era interpretada; nada aplicado, reavalio no próximo tick.`);
        return { resumed: false, conflict: e.code };
    }
    Object.assign(state, readTaskState(dir));
    checkWrittenState(dir);
    appendEvent(taskId, { type: 'human_input_interpreted', node: entry.from_node, agent: 'watcher', detail: `${decision.action} (${interp.intent}, confiança ${interp.confidence}): ${decision.reply}` }, dir);
    Object.assign(state, readTaskState(dir)); // traz o evento pro state em memória (gates abaixo regravam o arquivo)
    logRun(ticket.id, '[watcher]', `mensagem do dashboard interpretada — ${decision.reply}`);

    if (decision.action === 'resume') {
        // Se travar de novo no mesmo nó, o aviso de bloqueio precisa sair outra vez.
        try { fs.rmSync(notifiedMarkerPath(dir), { force: true }); } catch { /* best-effort */ }
        console.log(`Task ${taskId}: ${decision.reply}`);
        return { resumed: true, entry };
    }
    console.warn(`Task ${taskId}: mensagem não destravou a task — ${decision.reply}`);
    await replyToHumanInput(ticket, taskId, entry);
    return { resumed: false, entry };
}

// Resposta do intérprete quando NÃO retoma. O dashboard mostra a partir de
// state.human_input_interpretations; o Redmine só sem --follow (mesma regra do notifyBlocked).
async function replyToHumanInput(ticket, taskId, entry) {
    if (!FOLLOW) {
        try {
            await redmineFetch(`${REDMINE_URL}/issues/${ticket.id}.json`, {
                method: 'PUT',
                headers: { 'X-Redmine-API-Key': REDMINE_API_KEY, 'Content-Type': 'application/json' },
                body: JSON.stringify({ issue: { notes: `[Watcher] Sobre sua mensagem no dashboard (task ${taskId}, travada no nó "${entry.from_node}"):\n\n${entry.reply}\n\nResponda pelo dashboard (Responder ao agente).` } }),
            });
        } catch (e) {
            console.error(`Falha respondendo a mensagem no Redmine #${ticket.id}:`, e.message);
        }
    }
    try {
        execFileSync('osascript', ['-e', `display notification ${JSON.stringify(entry.reply.slice(0, 200))} with title ${JSON.stringify(`Ticket #${ticket.id}: sua mensagem não destravou`)}`], { stdio: 'ignore' });
    } catch { /* não é macOS */ }
}

async function notifyBlocked(ticket, taskId, node, status, dir, state, noteOverride = null) {
    const signature = `${node}:${status}`;
    const markerPath = notifiedMarkerPath(dir);
    if (alreadyNotified(markerPath, signature)) return;

    const note = noteOverride || lastAgentNote(state) || '(sem nota do agente no agent_log — ver handoff.md/context.md do worktree pro detalhe.)';
    // Só blocked/escalated/spec-change-rejected destravam por mensagem (interpretBlockedHumanInput); os outros
    // status exigem mexer no state.json. Comentário aqui no Redmine não é lido pelo watcher.
    const howToResume = HUMAN_INPUT_RESUMABLE_STATUSES.has(status)
        ? `Responda pelo dashboard (Responder ao agente): o watcher interpreta a mensagem e só retoma ` +
          `se ficar claro que é pra seguir — senão responde com o que entendeu e a task continua parada.`
        : `Para retomar, ajuste status/node em memory/runs/${taskId}/state.json no worktree deste ticket ` +
          `(ex.: status="in_progress") — o próximo tick segue dali.`;
    const msg =
        `[Watcher] Ticket #${ticket.id} travou no nó "${node}" (status: ${status}).\n\n${note}\n\n${howToResume}`;

    // Comentário no Redmine: canal que o usuário já acompanha, funciona remoto. Só faz
    // sentido sem --follow (cron/fire-and-forget, ninguém olhando o terminal) — com
    // --follow o usuário já está acompanhando ao vivo, e comentar no Redmine a cada
    // bloqueio de um segmento encadeado vira spam sem função (pedido explícito do
    // usuário, 2026-09-09). Best-effort — falha aqui não pode derrubar o tick nem
    // impedir o marcador de "já notificado" abaixo.
    if (!FOLLOW) {
        try {
            await redmineFetch(`${REDMINE_URL}/issues/${ticket.id}.json`, {
                method: 'PUT',
                headers: { 'X-Redmine-API-Key': REDMINE_API_KEY, 'Content-Type': 'application/json' },
                body: JSON.stringify({ issue: { notes: msg } }),
            });
        } catch (e) {
            console.error(`Falha comentando bloqueio no Redmine #${ticket.id}:`, e.message);
        }
    }

    // Notificação local (macOS): aviso imediato se estiver na máquina. execFileSync (não
    // execSync) pra passar o texto como argv, sem interpolar em shell string — a nota do
    // agente é texto livre e pode conter aspas/backticks.
    try {
        const title = `Ticket #${ticket.id} travou no nó ${node}`;
        execFileSync('osascript', ['-e', `display notification ${JSON.stringify(note.slice(0, 200))} with title ${JSON.stringify(title)}`], { stdio: 'ignore' });
    } catch {
        // Não é macOS, ou sem permissão de notificação — não bloqueia o tick.
    }

    markNotified(markerPath, signature);
}

// ---------------------------------------------------------------------------------
// Pergunta pré-task: mesma ideia de notifyBlocked, mas pro caso em que fetch_ticket
// trava ANTES de existir task-id (ex: working tree sujo no passo 2 de
// .claude/commands/fetch-ticket.md) — não há memory/runs/<task-id>/ ainda pra
// context.md/handoff.md servirem de canal de resposta, e sem isto o watcher
// redespachava fetch_ticket do zero a cada tick, com uma sessão nova (sem memória da
// anterior) fazendo a MESMA pergunta de novo pra sempre — a pergunta anterior e
// qualquer resposta digitada só no log (memory/runs/<ticket>.log, que é write-only,
// nunca relido) se perdiam. Achado ao vivo no ticket #42359: ~15 rodadas da mesma
// pergunta sobre working tree sujo, com respostas do usuário no meio que nenhum
// despacho seguinte via.
//
// Arquivo fica em RUNS_DIR (não no worktree, que pode nem existir ainda, ou ser
// justamente o que está sujo) — .claude/commands/fetch-ticket.md passo 2 escreve a
// pergunta aqui e relê antes de perguntar de novo; o usuário edita a seção
// "## Resposta" pra destravar.
function pretaskQuestionPath(ticketId) {
    return `${RUNS_DIR}/${ticketId}-pretask-question.md`;
}

function pretaskNotifiedMarkerPath(ticketId) {
    return `${RUNS_DIR}/${ticketId}-pretask-question.notified.json`;
}

// true = existe pergunta pré-task pendente (arquivo existe e a seção "## Resposta"
// está vazia). false tanto se não há arquivo (nunca travou, ou já foi limpo depois
// de respondida) quanto se há resposta escrita — nos dois casos o watcher segue o
// fluxo normal e deixa fetch_ticket decidir (ele que sabe reler a resposta).
function pretaskAnswerPending(ticketId) {
    const p = pretaskQuestionPath(ticketId);
    if (!fs.existsSync(p)) return false;
    const content = fs.readFileSync(p, 'utf8');
    const marker = '## Resposta';
    const idx = content.indexOf(marker);
    if (idx === -1) return false;
    const afterHeaderLine = content.indexOf('\n', idx);
    const answer = (afterHeaderLine === -1 ? '' : content.slice(afterHeaderLine + 1)).trim();
    return answer.length === 0;
}

async function notifyPretaskBlocked(ticket, ticketId) {
    const signature = 'pretask_question';
    const markerPath = pretaskNotifiedMarkerPath(ticketId);
    if (alreadyNotified(markerPath, signature)) return;

    const questionPath = pretaskQuestionPath(ticketId);
    const content = fs.existsSync(questionPath)
        ? fs.readFileSync(questionPath, 'utf8')
        : '(arquivo de pergunta não encontrado — ver memory/runs/' + ticketId + '.log pro último resultado de fetch_ticket.)';
    const msg =
        `[Watcher] Ticket #${ticket.id}: fetch_ticket travou antes de criar a task (working tree sujo ou situação ` +
        `equivalente) — há uma pergunta pendente.\n\n${content}\n\n` +
        `Responda editando memory/runs/${ticketId}-pretask-question.md (seção "## Resposta") no checkout ` +
        `principal do repo — o próximo tick retoma sozinho, não precisa reiniciar nada.`;

    // Mesmo raciocínio de notifyBlocked: sem sentido comentar no Redmine com --follow
    // (usuário já está acompanhando ao vivo no terminal).
    if (!FOLLOW) {
        try {
            await redmineFetch(`${REDMINE_URL}/issues/${ticket.id}.json`, {
                method: 'PUT',
                headers: { 'X-Redmine-API-Key': REDMINE_API_KEY, 'Content-Type': 'application/json' },
                body: JSON.stringify({ issue: { notes: msg } }),
            });
        } catch (e) {
            console.error(`Falha comentando bloqueio pré-task no Redmine #${ticket.id}:`, e.message);
        }
    }

    try {
        const title = `Ticket #${ticket.id}: fetch_ticket travou (pré-task)`;
        const body = `Pergunta pendente em memory/runs/${ticketId}-pretask-question.md`;
        execFileSync('osascript', ['-e', `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`], { stdio: 'ignore' });
    } catch {
        // Não é macOS, ou sem permissão de notificação — não bloqueia o tick.
    }

    markNotified(markerPath, signature);
}

// ---------------------------------------------------------------------------------
// Portão de qualidade da spec (scripts/lib/spec-validator.js). Roda ANTES de qualquer
// despacho que leve ao Plan — spec incompleta (sobretudo sem Critérios de Aceite)
// multiplica falha em todos os nós seguintes. Spec incompleta NÃO exige preenchimento:
// o ciclo pausa só até alguém dar ACEITE (comentário começando por "aceito" no ticket,
// ou --aceitar-spec=<id>) — depois segue, com as pendências como aviso no context.md
// (pedido do usuário, 2026-09-23: "pode pedir um aceite apenas, pra continuar").
// Dois pontos de validação, porque a spec existe em lugares diferentes conforme a
// fase:
//   - Ciclo novo (sem task ativa): ainda não existe memory/spec/<id>-spec.md — quem
//     escreve ela é o próprio fetch_ticket (agente). A única spec disponível antes
//     de qualquer agente é a DESCRIÇÃO DO TICKET, então é ela que é validada. Sem
//     task dir ainda, o "state" spec-invalid vai em RUNS_DIR/<id>-spec-gate.json.
//   - Task ativa em node=plan (ou já spec-invalid): valida memory/spec/<id>-spec.md
//     do worktree (o que o /plan vai ler de fato) e grava state.status='spec-invalid'
//     no state.json. Revalida a cada tick; quando passar, volta pra in_progress.
// Nunca edita a spec — só aponta o que falta (comentário no Redmine pedindo aceite,
// uma vez por combinação spec+problemas) e registra os avisos no context.md. O aceite
// vale pro ticket (gravado em <id>-spec-gate.json) — não é pedido de novo a cada tick
// nem se a spec mudar depois.

const SPEC_TEMPLATE_URL = process.env.SPEC_TEMPLATE_URL || path.join(PRISMA_ROOT, 'templates', 'spec-template.md');

function specGatePath(ticketId) {
    return `${RUNS_DIR}/${ticketId}-spec-gate.json`;
}

function specGateNotifiedMarkerPath(ticketId) {
    return `${RUNS_DIR}/${ticketId}-spec-gate.notified.json`;
}

function readSpecGate(ticketId) {
    const p = specGatePath(ticketId);
    if (!fs.existsSync(p)) return null;
    try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
        return null;
    }
}

function writeSpecGate(ticketId, gate) {
    fs.mkdirSync(RUNS_DIR, { recursive: true });
    fs.writeFileSync(specGatePath(ticketId), JSON.stringify(gate, null, 2));
}

// Comenta a rejeição no Redmine. Diferente de notifyBlocked, comenta também em
// --follow: o destinatário aqui é quem escreveu a spec (autor do ticket), não quem
// está olhando o terminal. Idempotente por assinatura (spec+problemas) e só marca
// como notificado se o PUT deu certo — falha de rede tenta de novo no próximo tick.
async function notifySpecInvalid(ticket, result, signature, { sourceLabel, fixInstruction }) {
    const markerPath = specGateNotifiedMarkerPath(ticket.id);
    if (alreadyNotified(markerPath, signature)) return;
    const msg = specValidator.formatRedmineComment(result, {
        ticketId: ticket.id, sourceLabel, fixInstruction, templateUrl: SPEC_TEMPLATE_URL,
    });
    try {
        const res = await redmineFetch(`${REDMINE_URL}/issues/${ticket.id}.json`, {
            method: 'PUT',
            headers: { 'X-Redmine-API-Key': REDMINE_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ issue: { notes: msg } }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
        console.error(`Falha comentando spec inválida no Redmine #${ticket.id}:`, e.message);
        return;
    }
    fs.mkdirSync(RUNS_DIR, { recursive: true });
    markNotified(markerPath, signature);
}

// Critério [PENDING_CLARIFICATION]: comenta uma vez por spec+problemas (mesma
// idempotência de notifySpecInvalid, marcador próprio).
async function notifySpecClarification(ticket, result, signature, specLocation) {
    const markerPath = `${RUNS_DIR}/${ticket.id}-spec-clarification.notified.json`;
    if (alreadyNotified(markerPath, signature)) return;
    const msg = specValidator.formatPendingClarificationComment(result, { ticketId: ticket.id, specLocation });
    if (!await postRedmineNote(ticket.id, msg)) return;
    fs.mkdirSync(RUNS_DIR, { recursive: true });
    markNotified(markerPath, signature);
}

// true se a spec incompleta deste ticket já foi aceita. Fontes, nesta ordem: aceite
// já gravado no gate file; flag --aceitar-spec; comentário no Redmine começando por
// "aceito" (ver specValidator.isAcceptanceNote) feito DEPOIS do comentário de
// pendência do watcher — comentário anterior ao pedido não conta como resposta.
// Ao achar um aceite novo, grava accepted_at/accepted_by no gate file (fora de dry-run).
// Comentários (não do watcher) feitos no ticket DEPOIS do último pedido de spec do
// watcher — é onde chega a resposta: um "aceito", ou a própria spec complementada
// (achado ao vivo no #43584, Recusa QA: Problema/Solução/Critérios vieram num
// comentário, não na descrição). [] se o watcher nunca pediu ou se o Redmine falhar.
async function fetchSpecReplies(ticketId) {
    // Pedido = comentário de pendência do portão OU comentário do auto-repair (draft).
    return fetchRepliesAfter(ticketId, [specValidator.REDMINE_COMMENT_PREFIX, specValidator.SPEC_REPAIR_COMMENT_PREFIX], 'checar resposta da spec');
}

// Respostas humanas depois do ÚLTIMO comentário do watcher que começa por um dos
// prefixos (o pedido). Base de toda aprovação via Redmine: draft do auto-repair
// (spec-pending-approval) e SPEC_CHANGE proposta pelo /implement.
async function fetchRepliesAfter(ticketId, prefixes, purpose = 'checar resposta') {
    let journals = [];
    try {
        const res = await redmineFetch(
            `${REDMINE_URL}/issues/${ticketId}.json?include=journals`,
            { headers: { 'X-Redmine-API-Key': REDMINE_API_KEY } }
        );
        if (res.ok) journals = (await res.json()).issue?.journals || [];
    } catch (e) {
        console.error(`Falha lendo comentários do Redmine #${ticketId} pra ${purpose}:`, e.message);
        return [];
    }
    const notes = journals.filter(j => j.notes && j.notes.trim());
    let askedAt = -1;
    notes.forEach((j, i) => {
        const t = j.notes.trim();
        if (prefixes.some(prefix => t.startsWith(prefix))) askedAt = i;
    });
    if (askedAt === -1) return [];
    return notes.slice(askedAt + 1).filter(j => !specValidator.isWatcherNote(j.notes));
}

// Spec incompleta + respostas no Redmine: se a descrição/arquivo somado aos
// comentários de resposta passar na validação, a spec conta como completada ali.
// Retorna {content, result, replies} — content/result já combinados quando isso ajudou.
// validateOpts: mesma política de IDs AC-XX da validação original (ver runTaskSpecGate).
function withSpecReplies(content, result, replies, validateOpts = {}) {
    const specReplies = replies.filter(j => !specValidator.isAcceptanceNote(j.notes) && !specValidator.isApprovalNote(j.notes, SPEC_APPROVAL_KEYWORD));
    if (result.valid || specReplies.length === 0) return { content, result, completedBy: null, completedByJournalIds: [] };
    const combined = `${content}\n\n${specReplies.map(j => j.notes.trim()).join('\n\n')}`;
    const combinedResult = specValidator.validateSpec(combined, validateOpts);
    if (!combinedResult.valid) return { content, result, completedBy: null, completedByJournalIds: [] };
    const last = specReplies[specReplies.length - 1];
    // Journals que completaram a spec: evidência do PORTÃO (nível ticket), nunca
    // provenance de um AC — o texto combinado só é validado, não vira AC-NN em lugar
    // nenhum (EC-2, docs/ac-provenance-sources.md).
    const completedByJournalIds = specReplies.map(j => j.id).filter(Number.isInteger);
    return { content: combined, result: combinedResult, completedBy: `${last.user?.name || '?'} (comentário no Redmine, ${last.created_on})`, completedByJournalIds };
}

async function specAccepted(ticketId, replies) {
    const gate = readSpecGate(ticketId) || { ticket_id: ticketId };
    if (gate.accepted_at) return true;

    let acceptedBy = null;
    if (ACCEPT_SPEC_IDS.has(ticketId)) {
        acceptedBy = 'flag --aceitar-spec';
    } else {
        const answer = (replies || []).find(j => specValidator.isAcceptanceNote(j.notes));
        if (!answer) return false;
        acceptedBy = `${answer.user?.name || '?'} (Redmine, ${answer.created_on})`;
    }

    if (!DRY_RUN) writeSpecGate(ticketId, { ...gate, accepted_at: new Date().toISOString(), accepted_by: acceptedBy });
    console.log(`Ticket #${ticketId}: spec incompleta aceita por ${acceptedBy} — seguindo o ciclo.`);
    return true;
}

// Pendências de uma spec aceita viram avisos do context.md (erros + recomendações).
function acceptedAsWarnings(result) {
    return { valid: true, errors: [], warnings: [...(result.errors || []), ...(result.warnings || [])] };
}

// Mantém o bloco de avisos do validador no context.md da task (insere, atualiza ou
// remove — idempotente via marcadores). Não cria context.md se ele ainda não existe
// E não há o que avisar.
function syncSpecWarningsToContext(taskDir, result, sourceLabel, accepted = false) {
    const p = `${taskDir}/context.md`;
    const existing = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    const updated = specValidator.upsertContextWarnings(
        existing, accepted ? acceptedAsWarnings(result) : result, { sourceLabel, accepted });
    if (updated !== existing) fs.writeFileSync(p, updated);
}

// ---------------------------------------------------------------------------------
// Auto-repair da spec (scripts/lib/spec-repairer.js): em vez de só pedir aceite, gera
// por IA as seções obrigatórias que faltam, salva como draft (a spec atual nunca é
// tocada) e comenta o draft no Redmine. Resposta com SPEC_APPROVAL_KEYWORD (padrão
// "aprovado") depois desse comentário → o watcher mescla o draft na spec, apaga o draft
// e segue o ciclo; "aceito" continua valendo (segue sem o draft); spec editada que
// passe no portão segue sozinha. Pendência de aprovação vive em <id>-spec-gate.json
// (spec_pending_approval) — antes de existir task não há state.json — e, com task
// ativa, é espelhada em state.json (status "spec-pending-approval"). Aprovar = aceitar:
// o que ainda faltar depois da mescla (ex: placeholder "A definir") vira aviso, nunca
// um novo draft. SPEC_AUTO_REPAIR=0 desliga (volta ao pedido de aceite puro).

const SPEC_AUTO_REPAIR = process.env.SPEC_AUTO_REPAIR !== '0';
const SPEC_APPROVAL_KEYWORD = specValidator.approvalKeyword();
const SPEC_APPROVAL_REMINDER_HOURS = Number(process.env.SPEC_APPROVAL_REMINDER_HOURS) > 0
    ? Number(process.env.SPEC_APPROVAL_REMINDER_HOURS) : 48;
// Status de task que o portão de spec pausou — voltam pra in_progress quando destravar.
const SPEC_GATE_STATUSES = new Set(['spec-invalid', 'spec-pending-approval']);

function specDraftRel(ticketId) {
    return `memory/spec/${ticketId}-spec.draft.md`;
}

function removeSpecDraft(ticketId) {
    try { fs.rmSync(`${REPO_PATH}/${specDraftRel(ticketId)}`, { force: true }); } catch {}
}

async function postRedmineNote(ticketId, notes) {
    try {
        const res = await redmineFetch(`${REDMINE_URL}/issues/${ticketId}.json`, {
            method: 'PUT',
            headers: { 'X-Redmine-API-Key': REDMINE_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ issue: { notes } }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return true;
    } catch (e) {
        console.error(`Falha comentando no Redmine #${ticketId}:`, e.message);
        return false;
    }
}

// Id (journal) do comentário que o watcher acabou de postar — o PUT do Redmine devolve
// 204 sem corpo, então relê os journals. null se não achar (cai no posted_at).
async function findJournalId(ticketId, prefix) {
    try {
        const res = await redmineFetch(`${REDMINE_URL}/issues/${ticketId}.json?include=journals`,
            { headers: { 'X-Redmine-API-Key': REDMINE_API_KEY } });
        if (!res.ok) return null;
        const journals = (await res.json()).issue?.journals || [];
        const mine = journals.filter(j => j.notes && j.notes.trim().startsWith(prefix));
        return mine.length && Number.isInteger(mine[mine.length - 1].id) ? mine[mine.length - 1].id : null;
    } catch {
        return null;
    }
}

function repliedAfter(journal, pending) {
    if (Number.isInteger(pending.comment_id) && Number.isInteger(journal.id)) return journal.id > pending.comment_id;
    return new Date(journal.created_on || 0).getTime() >= new Date(pending.posted_at || 0).getTime();
}

// Primeira resposta de decisão depois do pedido `pending` ({comment_id, posted_at}):
// {decision: 'approved'|'rejected', by, journal}, ou null. Sem rejectKeyword, só aprova.
function findApprovalReply(replies, pending, { approveKeyword = SPEC_APPROVAL_KEYWORD, rejectKeyword = null } = {}) {
    for (const j of (replies || []).filter(r => repliedAfter(r, pending))) {
        const decision = specValidator.isApprovalNote(j.notes, approveKeyword) ? 'approved'
            : rejectKeyword && specValidator.isRejectionNote(j.notes, rejectKeyword) ? 'rejected' : null;
        if (decision) return { decision, by: `${j.user?.name || '?'} (Redmine, ${j.created_on})`, journal: j };
    }
    return null;
}

// Provenance de AC (scripts/lib/ac-provenance.js): log append-only no checkout
// principal, memory/spec/<ticket>-ac-provenance.json. Só evidência real; falha aqui
// nunca derruba o tick. Dry-run não grava (ticket fictício não entra em dado real).
function recordAcProvenance(ticketId, events, label) {
    if (DRY_RUN || !events || !events.length) return null;
    try {
        const out = acProvenance.appendEvents(ticketId, events, { root: REPO_PATH });
        if (!out.ok) console.warn(`Ticket #${ticketId}: provenance de AC (${label}) não registrada: ${out.errors.join('; ')}`);
        else if (out.added.length) console.log(`Ticket #${ticketId}: provenance de AC (${label}) — ${out.added.length} evento(s) em ${path.relative(REPO_PATH, out.file)}.`);
        return out;
    } catch (e) {
        console.warn(`Ticket #${ticketId}: provenance de AC (${label}) falhou: ${e.message}`);
        return null;
    }
}

// Gera o draft, grava e comenta no Redmine. Devolve o objeto spec_pending_approval, ou
// null se o comentário falhou (draft apagado — o próximo tick tenta de novo do zero).
async function startSpecRepair(ticket, { content, result, sourceLabel, specLocation }) {
    const id = ticket.id;
    const sectionsMd = await specRepairer.repairSpec({
        specContent: content, ticketData: ticket, missingSections: result.missingSections,
        onFallback: reason => console.warn(`Ticket #${id}: auto-repair da spec sem resposta do Claude (${reason}) — seções vão com placeholder.`),
    });
    const draftRel = specDraftRel(id);
    const draftAbs = `${REPO_PATH}/${draftRel}`;
    fs.mkdirSync(path.dirname(draftAbs), { recursive: true });
    fs.writeFileSync(draftAbs, specRepairer.formatDraftFile({ ticketId: id, sectionsMd }));
    const msg = specRepairer.formatRepairComment({
        ticketId: id, result, sectionsMd, specLocation, draftPath: draftRel, keyword: SPEC_APPROVAL_KEYWORD, sourceLabel,
    });
    const postedAt = new Date().toISOString();
    if (!await postRedmineNote(id, msg)) {
        removeSpecDraft(id);
        return null;
    }
    const commentId = await findJournalId(id, specValidator.SPEC_REPAIR_COMMENT_PREFIX);
    console.log(`Ticket #${id}: spec incompleta — draft das seções ${result.missingSections.join(', ')} em ${draftRel}, aguardando "${SPEC_APPROVAL_KEYWORD}" no Redmine.`);
    return {
        comment_id: commentId, draft_path: draftRel, posted_at: postedAt, reminder_sent: false,
        missing_sections: result.missingSections, keyword: SPEC_APPROVAL_KEYWORD,
    };
}

// Lembrete único depois de SPEC_APPROVAL_REMINDER_HOURS sem resposta. Muta `pending`.
async function maybeRemindSpecApproval(ticket, pending, specLocation) {
    if (pending.reminder_sent) return;
    const ageMs = Date.now() - new Date(pending.posted_at || 0).getTime();
    if (ageMs < SPEC_APPROVAL_REMINDER_HOURS * 3600 * 1000) return;
    const msg = specRepairer.formatReminderComment({
        ticketId: ticket.id, hours: SPEC_APPROVAL_REMINDER_HOURS, keyword: pending.keyword || SPEC_APPROVAL_KEYWORD, specLocation,
    });
    if (await postRedmineNote(ticket.id, msg)) {
        pending.reminder_sent = true;
        pending.reminder_sent_at = new Date().toISOString();
    }
}

// Spec que não passou nem por aceite. Devolve {pending, approved, failed}:
//   approved = {content, result, by, merged} — draft aprovado e já mesclado em mergeTarget;
//   pending  = spec_pending_approval atual (novo ou já existente) — segue pausado;
//   failed   = auto-repair tentou e não conseguiu comentar (não comenta de novo agora);
//   tudo vazio = auto-repair não se aplica (desligado ou só TOO_SHORT) → pedido de aceite.
async function handleSpecRepair(ticket, { content, result, replies, sourceLabel, specLocation, mergeBase, mergeTarget, validateOpts = {} }) {
    const id = ticket.id;
    const pending = readSpecGate(id)?.spec_pending_approval || null;
    if (pending) {
        const keyword = pending.keyword || SPEC_APPROVAL_KEYWORD;
        const approval = findApprovalReply(replies, pending, { approveKeyword: keyword });
        if (!approval) {
            if (!DRY_RUN) await maybeRemindSpecApproval(ticket, pending, specLocation);
            return { pending, approved: null };
        }
        const { by, journal } = approval;
        const draftAbs = path.join(REPO_PATH, pending.draft_path || specDraftRel(id));
        if (!fs.existsSync(draftAbs)) {
            console.warn(`Ticket #${id}: "${keyword}" recebido, mas o draft ${pending.draft_path} sumiu — gero uma sugestão nova.`);
            return { pending: null, approved: null, lostDraft: true };
        }
        if (DRY_RUN) {
            console.log(`[dry-run] #${id}: draft aprovado por ${by} — mesclaria ${pending.draft_path} em ${mergeTarget}.`);
            return { pending, approved: null };
        }
        const { content: merged, merged: keys } = specRepairer.mergeDraft(mergeBase, fs.readFileSync(draftAbs, 'utf8'));
        fs.mkdirSync(path.dirname(mergeTarget), { recursive: true });
        fs.writeFileSync(mergeTarget, merged);
        removeSpecDraft(id);
        // ACs que o merge acrescentou foram escritos pelo agente e aprovados por humano.
        if (keys.includes('criterios_aceite')) {
            const before = new Set(acRegistry.extractACs(mergeBase, id).acIds);
            const addedAcs = acRegistry.extractACs(merged, id).acIds.filter(ac => !before.has(ac));
            recordAcProvenance(id, acProvenance.agentDraftEvents(id, addedAcs, {
                via: 'spec-repairer', draftCommentId: Number.isInteger(pending.comment_id) ? pending.comment_id : null,
                approvalJournalId: Number.isInteger(journal?.id) ? journal.id : null, approvedBy: by, approvedAt: journal?.created_on ?? null,
                mergedSections: keys, specPath: path.relative(REPO_PATH, mergeTarget).startsWith('..') ? null : path.relative(REPO_PATH, mergeTarget),
            }), 'auto-repair aprovado');
        }
        console.log(`Ticket #${id}: draft da spec aprovado por ${by} — seções ${keys.join(', ') || '(nenhuma, já preenchidas)'} mescladas em ${mergeTarget}.`);
        return { pending: null, approved: { content: merged, result: specValidator.validateSpec(merged, validateOpts), by, merged: keys } };
    }
    if (!SPEC_AUTO_REPAIR || !result.missingSections?.length) return { pending: null, approved: null };
    if (DRY_RUN) {
        console.log(`[dry-run] #${id}: geraria draft (auto-repair) das seções ${result.missingSections.join(', ')} e comentaria no Redmine.`);
        return { pending: null, approved: null, failed: true };
    }
    const created = await startSpecRepair(ticket, { content, result, sourceLabel, specLocation });
    return created ? { pending: created, approved: null } : { pending: null, approved: null, failed: true };
}

// Campos do gate file quando um draft é aprovado: aprovar vale como aceite (o que
// sobrar incompleto depois da mescla não trava o ciclo nem gera outro draft).
function approvedRepairGateFields(approved, specPath) {
    const at = new Date().toISOString();
    return {
        accepted_at: at,
        accepted_by: `aprovação do draft do auto-repair por ${approved.by}`,
        spec_repair: { approved_at: at, approved_by: approved.by, merged_sections: approved.merged, spec_path: specPath },
    };
}

// ---------------------------------------------------------------------------------
// Spec rascunho gerado dos campos do ticket (scripts/lib/spec-generator.js). Ticket
// novo sem memory/spec/<id>-spec.md: gera o rascunho (category → módulo/microsserviços,
// fixed_version → versão alvo, estimated_hours → granularidade do plan, description →
// problema), grava com `draft: true` e comenta no Redmine. Enquanto o frontmatter tiver
// `draft: true` o ciclo NÃO começa — só um humano libera, trocando para `draft: false`
// (ou apagando a linha). Spec já existente nunca é sobrescrita (gravação com 'wx').
// memory/spec é linkada em cada worktree (linkLocalMemory), então a spec da raiz é a
// mesma que o /fetch-ticket e o /plan leem. SPEC_DRAFT_AUTOGEN=0 desliga a geração (o
// bloqueio de spec com `draft: true` continua valendo).
const SPEC_DRAFT_AUTOGEN = process.env.SPEC_DRAFT_AUTOGEN !== '0';
// Base de URL opcional pro link do comentário (ex: navegador de arquivos do checkout
// do watcher). Sem ela o comentário cita só o caminho no repo — memory/ não é versionada.
const SPEC_DRAFT_LINK_BASE = (process.env.SPEC_DRAFT_LINK_BASE || '').replace(/\/+$/, '');
const SPEC_DRAFT_COMMENT_PREFIX = '[Watcher] Spec rascunho gerado automaticamente — revisar antes de iniciar ciclo';

function specRelFor(ticketId) {
    return `memory/spec/${ticketId}-spec.md`;
}

function specDraftNotifiedMarkerPath(ticketId) {
    return `${RUNS_DIR}/${ticketId}-spec-draft.notified.json`;
}

// memory/ não é versionada: sem o texto no comentário, quem olha o Redmine não tem como
// revisar o rascunho. Vai sem frontmatter e sem os comentários HTML do template.
const SPEC_DRAFT_COMMENT_MAX_CHARS = 20000;

function specDraftBody(content) {
    const body = String(content || '')
        .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
        .replace(/<!--[\s\S]*?-->\r?\n?/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return body.length > SPEC_DRAFT_COMMENT_MAX_CHARS
        ? `${body.slice(0, SPEC_DRAFT_COMMENT_MAX_CHARS)}\n\n[… truncado — spec completa no arquivo]`
        : body;
}

function escapeHtml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Seções que o spec-repairer (IA) sugeriu no rascunho — frontmatter `ai_sections`.
function specDraftAiSections(content) {
    const raw = content != null ? specGenerator.parseFrontmatter(content)?.ai_sections : null;
    return typeof raw === 'string' ? raw.split(',').map(k => k.trim()).filter(Boolean) : [];
}

function sectionHeadings(keys) {
    return keys.map(k => specValidator.REQUIRED_SECTIONS.find(d => d.key === k)?.heading || k).join(', ');
}

// O ticket quase nunca traz Solução/Critérios de Aceite em subseção, e o gerador não
// inventa: sem isto o rascunho saía com as duas vazias. O spec-repairer (IA) sugere as
// seções obrigatórias que faltam DENTRO do rascunho — que segue `draft: true`, então nada
// chega ao ciclo sem revisão humana — e o frontmatter registra quais vieram da IA.
// Falha/timeout do Claude: rascunho fica como estava (sem placeholder).
async function fillSpecDraftGaps(ticket, content) {
    if (!SPEC_AUTO_REPAIR) return { content, aiSections: [] };
    const missing = specValidator.validateSpec(content).missingSections;
    if (!missing.length) return { content, aiSections: [] };
    let fallback = null;
    const sectionsMd = await specRepairer.repairSpec({
        specContent: content, ticketData: ticket, missingSections: missing, onFallback: reason => { fallback = reason; },
    });
    // Seção que voltou só com o PLACEHOLDER ("A definir…" — resposta vazia/ilegível, ou o
    // Claude achou o ticket vago demais) fica vazia: vazia o portão aponta, placeholder não.
    // "A definir" num item de seção preenchida fica: é o ponto que o revisor precisa ver.
    const suggested = fallback ? '' : sectionsMd.split(/\n(?=## )/)
        .filter(sec => !specRepairer.isPlaceholderOnly(sec)).join('\n\n');
    if (!suggested.trim()) {
        console.warn(`Ticket #${ticket.id}: IA não sugeriu ${sectionHeadings(missing)} no rascunho (${fallback || 'resposta vazia'}) — seções ficam vazias pra revisão.` +
            (/timeout/i.test(fallback || '') ? ' Ticket grande? Aumente SPEC_REPAIR_TIMEOUT_MS no .env.' : ''));
        return { content, aiSections: [] };
    }
    const { content: merged, merged: keys } = specRepairer.mergeDraft(content, suggested);
    if (!keys.length) return { content, aiSections: [] };
    const withMarker = merged.replace(/^(generated_at:.*)$/m, `$1\nai_sections: ${keys.join(', ')}`);
    console.log(`Ticket #${ticket.id}: rascunho da spec com ${sectionHeadings(keys)} sugeridas por IA.`);
    return { content: withMarker, aiSections: keys };
}

function specDraftComment(ticketId, meta = {}, content = null) {
    const rel = specRelFor(ticketId);
    const link = SPEC_DRAFT_LINK_BASE ? `${SPEC_DRAFT_LINK_BASE}/${rel}` : null;
    const lines = [
        SPEC_DRAFT_COMMENT_PREFIX,
        '',
        `Spec: ${link ? `"${rel}":${link}` : `@${rel}@`} (checkout do watcher)`,
    ];
    const body = content != null ? specDraftBody(content) : '';
    if (body) lines.push('', '{{collapse(Ver spec gerada)', '<pre>', escapeHtml(body), '</pre>', '}}');
    if (meta.category || meta.targetVersion || meta.estimatedHours != null) {
        lines.push('', 'Campos do ticket usados:');
        if (meta.category) lines.push(`* Categoria → Módulo Afetado: ${meta.category}${meta.microservices?.length ? ` (${meta.microservices.join(', ')} — inferido)` : ''}`);
        if (meta.targetVersion) lines.push(`* Versão prevista → Versão Alvo: ${meta.targetVersion}`);
        if (meta.estimatedHours != null) lines.push(`* Tempo estimado → granularidade do plan: ${meta.estimatedHours}h`);
    }
    const ai = specDraftAiSections(content);
    if (ai.length) lines.push('', `*Sugerido por IA (não veio do ticket), revise com atenção:* ${sectionHeadings(ai)}`);
    lines.push('', `${ai.length
        ? 'O ciclo NÃO inicia enquanto a spec tiver `draft: true` no frontmatter. Revise o conteúdo'
        : 'O ciclo NÃO inicia enquanto a spec tiver `draft: true` no frontmatter. Revise o conteúdo (Solução e Critérios de Aceite nunca são inventados)'} e responda *${SPEC_APPROVAL_KEYWORD}* neste ticket (ou troque para \`draft: false\` no arquivo) para liberar.`);
    return lines.join('\n');
}

// Comenta o rascunho uma vez (marcador por ticket). Falha de rede não marca: o próximo
// tick, vendo a spec ainda em draft, tenta de novo. O sufixo da assinatura marca o
// formato com o texto da spec — rascunho ainda pendente que só recebeu o comentário
// antigo (só o caminho) ganha um novo, desta vez com o conteúdo.
async function notifySpecDraft(ticketId, meta, content) {
    const markerPath = specDraftNotifiedMarkerPath(ticketId);
    const signature = `${specRelFor(ticketId)}#conteudo`;
    if (alreadyNotified(markerPath, signature)) return true;
    const ok = await postRedmineNote(ticketId, specDraftComment(ticketId, meta, content));
    if (ok) {
        fs.mkdirSync(RUNS_DIR, { recursive: true });
        markNotified(markerPath, signature);
    }
    return ok;
}

function readSpecIfExists(abs) {
    try {
        return fs.readFileSync(abs, 'utf8');
    } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
    }
}

// DRY-RUN: simula a revisão humana do rascunho (draft: true → draft: false) e reavalia
// o portão — sem isto o ciclo simulado pararia aqui toda vez, como pede o portão real.
async function simulateSpecDraftReview(ticket, draftCheck) {
    const abs = `${REPO_PATH}/${draftCheck.specRel}`;
    const content = readSpecIfExists(abs);
    if (content == null || !specGenerator.isDraftSpec(content)) return draftCheck;
    fs.writeFileSync(abs, content.replace(/^draft:\s*true\s*$/m, 'draft: false'));
    console.log(`[dry-run] #${ticket.id}: revisão humana do rascunho simulada — ${draftCheck.specRel} liberada (draft: false).`);
    return runSpecDraftGate(ticket);
}

// Pendência pré-task no gate file (status "spec-draft"): sem state.json, é daqui que o
// dashboard monta o run sintético "<id>-spec-gate" com o rascunho pra revisar. Só grava
// na transição; runTicketSpecGate sobrescreve o status quando a spec for liberada.
// fetch_dispatch antigo sai: com o rascunho pendente nada é despachado.
function markSpecDraftGate(ticket, rel, content, draftAcIds = null) {
    const previous = readSpecGate(ticket.id) || { ticket_id: ticket.id };
    // Quais ACs do rascunho vieram da descrição e quais a IA sugeriu: evidência do portão
    // que vira AGENT_DRAFT_APPROVED quando o humano libera (recordReleasedDraftAgentAcs).
    if (draftAcIds) {
        try { writeSpecGate(ticket.id, { ...previous, spec_draft_ac_ids: draftAcIds }); previous.spec_draft_ac_ids = draftAcIds; } catch (e) {
            console.error(`Ticket #${ticket.id}: falha gravando os ACs do rascunho no gate file:`, e.message);
        }
    }
    const aiSections = specDraftAiSections(content);
    if (previous.status === 'spec-draft' && previous.spec_draft?.spec_path === rel && !previous.fetch_dispatch
        && JSON.stringify(previous.spec_draft?.ai_sections || []) === JSON.stringify(aiSections)) return;
    const at = new Date().toISOString();
    try {
        writeSpecGate(ticket.id, {
            ...previous,
            ticket_id: ticket.id,
            subject: ticket.subject || previous.subject,
            status: 'spec-draft',
            spec_draft: { spec_path: rel, since: previous.spec_draft?.since || at, ...(aiSections.length ? { ai_sections: aiSections } : {}) },
            fetch_dispatch: undefined,
            checked_at: at,
        });
    } catch (e) {
        console.error(`Ticket #${ticket.id}: falha gravando pendência do rascunho no gate file:`, e.message);
    }
}

// Aprovação do rascunho no Redmine: resposta começando por SPEC_APPROVAL_KEYWORD depois
// do ÚLTIMO comentário do rascunho (aprova a versão que foi mostrada). É o que o botão
// "Aprovar" do dashboard posta. Devolve {by: "Nome (Redmine, data)", journalId} ou null.
async function specDraftApproval(ticketId) {
    let journals = [];
    try {
        const res = await redmineFetch(`${REDMINE_URL}/issues/${ticketId}.json?include=journals`,
            { headers: { 'X-Redmine-API-Key': REDMINE_API_KEY } });
        if (!res.ok) return null;
        journals = (await res.json()).issue?.journals || [];
    } catch (e) {
        console.error(`Falha lendo comentários do Redmine #${ticketId} pra checar aprovação do rascunho:`, e.message);
        return null;
    }
    const notes = journals.filter(j => j.notes && j.notes.trim());
    let postedAt = -1;
    notes.forEach((j, i) => { if (j.notes.trim().startsWith(SPEC_DRAFT_COMMENT_PREFIX)) postedAt = i; });
    if (postedAt === -1) return null;
    const hit = notes.slice(postedAt + 1)
        .filter(j => !specValidator.isWatcherNote(j.notes))
        .find(j => specValidator.isApprovalNote(j.notes, SPEC_APPROVAL_KEYWORD));
    return hit ? { by: `${hit.user?.name || '?'} (Redmine, ${hit.created_on})`, journalId: Number.isInteger(hit.id) ? hit.id : null } : null;
}

// Aprovado = o mesmo que o humano trocar para `draft: false` à mão; quem aprovou fica
// no frontmatter e no gate file (spec_draft_approved sobrevive ao runTicketSpecGate).
function releaseSpecDraft(ticket, abs, content, approvedBy, journalId = null) {
    const released = content.replace(/^draft:\s*true\s*$/m, `draft: false\napproved_by: "${approvedBy.replace(/"/g, "'")}"`);
    fs.writeFileSync(abs, released);
    const previous = readSpecGate(ticket.id) || { ticket_id: ticket.id };
    writeSpecGate(ticket.id, { ...previous, spec_draft_approved: { by: approvedBy, at: new Date().toISOString(), ...(journalId != null ? { journal_id: journalId } : {}) } });
    console.log(`Ticket #${ticket.id}: spec rascunho aprovada por ${approvedBy} — draft: false, ciclo liberado.`);
}

// Rascunho liberado (draft: false): os ACs que a IA sugeriu no rascunho e que continuam
// na spec revisada viram AGENT_DRAFT_APPROVED/ORIGIN — autoria do agente, autoridade de
// quem liberou. Aprovado no Redmine: approved_by/journal do gate; liberado à mão no
// arquivo: approval "manual-draft-release", sem autor (não é inventado). Idempotente.
function recordReleasedDraftAgentAcs(ticket, rel, content) {
    if (DRY_RUN) return;
    const gate = readSpecGate(ticket.id);
    const drafted = gate?.spec_draft_ac_ids;
    if (!drafted || !Array.isArray(drafted.agent) || !drafted.agent.length) return;
    const present = new Set(acRegistry.extractACs(content, ticket.id).acIds);
    const kept = drafted.agent.filter(ac => present.has(ac));
    const approved = gate.spec_draft_approved;
    recordAcProvenance(ticket.id, acProvenance.agentDraftEvents(ticket.id, kept, {
        via: 'spec-generator', approvedBy: approved?.by ?? null, approvedAt: approved?.at ?? null,
        approvalJournalId: approved?.journal_id ?? null, approval: approved ? 'redmine' : 'manual-draft-release',
        specPath: rel, draftCommentId: null,
    }).map(ev => ({ ...ev, key: `spec-generator-${drafted.generated_at || 'sem-data'}` })), 'rascunho liberado');
}

// Devolve { block, reason, generated? }. block=true → dispatchTicket não despacha nada.
async function runSpecDraftGate(ticket) {
    const id = ticket.id;
    const rel = specRelFor(id);
    const abs = `${REPO_PATH}/${rel}`;
    const existing = readSpecIfExists(abs);

    if (existing != null) {
        if (!specGenerator.isDraftSpec(existing)) {
            recordReleasedDraftAgentAcs(ticket, rel, existing);
            return { block: false };
        }
        if (!DRY_RUN) {
            const approval = await specDraftApproval(id);
            if (approval) {
                releaseSpecDraft(ticket, abs, existing, approval.by, approval.journalId);
                recordReleasedDraftAgentAcs(ticket, rel, fs.readFileSync(abs, 'utf8'));
                return { block: false };
            }
            markSpecDraftGate(ticket, rel, existing);
            await notifySpecDraft(id, {}, existing);
        }
        return { block: true, reason: 'spec_draft_aguardando_revisao', specRel: rel };
    }
    if (!SPEC_DRAFT_AUTOGEN) return { block: false };
    if (DRY_RUN) {
        console.log(`[dry-run] #${id}: geraria spec rascunho em ${rel} (draft: true) e comentaria no Redmine.`);
        return { block: true, reason: 'spec_draft_gerado', specRel: rel };
    }

    let draft;
    try {
        const client = specGenerator.createRestMcpClient({ baseUrl: REDMINE_URL, apiKey: REDMINE_API_KEY, fetchImpl: redmineFetch });
        draft = await specGenerator.generateSpecDraft(id, client, { repoRoot: REPO_PATH });
    } catch (e) {
        console.error(`Ticket #${id}: falha gerando spec rascunho (tento de novo no próximo tick):`, e.message);
        return { block: true, reason: 'spec_draft_falhou', specRel: rel };
    }
    // ACs que já saem do gerador vieram da subseção "Critérios de Aceite" da descrição;
    // os que aparecem depois do fillSpecDraftGaps foram sugeridos pela IA.
    const descriptionAcs = acRegistry.extractACs(draft.content, id).acIds;
    ({ content: draft.content } = await fillSpecDraftGaps(ticket, draft.content));
    const agentAcs = acRegistry.extractACs(draft.content, id).acIds.filter(ac => !descriptionAcs.includes(ac));
    try {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, draft.content, { flag: 'wx' }); // nunca sobrescreve
    } catch (e) {
        if (e.code === 'EEXIST') return runSpecDraftGate(ticket); // alguém gravou no meio — reavalia
        throw e;
    }
    console.log(`Ticket #${id}: spec rascunho gerado em ${rel} (draft: true) — ciclo aguardando revisão humana.`);
    const generatedAt = new Date().toISOString();
    recordAcProvenance(id, acProvenance.descriptionOriginEvents(id, descriptionAcs, { specPath: rel, generatedAt }), 'descrição do ticket');
    markSpecDraftGate(ticket, rel, draft.content, { description: descriptionAcs, agent: agentAcs, generated_at: generatedAt });
    await notifySpecDraft(id, draft.meta, draft.content);
    return { block: true, reason: 'spec_draft_gerado', specRel: rel, generated: draft.meta };
}

// Spec gerada pelo spec-generator e já liberada (draft removido): é ela — não a
// descrição crua do ticket — que o portão de spec valida no ciclo novo.
function reviewedGeneratedSpec(ticketId) {
    const content = readSpecIfExists(`${REPO_PATH}/${specRelFor(ticketId)}`);
    if (content == null || specGenerator.isDraftSpec(content) || !specGenerator.isGeneratedSpec(content)) return null;
    return content;
}

// Ciclo novo: valida a descrição do ticket. Retorna {result, accepted, proceed, pending}:
// proceed=false só quando a spec é incompleta E ainda não foi aceita/aprovada.
async function runTicketSpecGate(ticket) {
    const id = ticket.id;
    const specRel = `memory/spec/${id}-spec.md`;
    // Spec gerada pelo spec-generator e liberada por humano: é o que o /plan vai ler.
    const reviewed = reviewedGeneratedSpec(id);
    const description = reviewed ?? (ticket.description || '');
    const baseLabel = reviewed ? `${specRel} (gerada do ticket #${id} e revisada)` : `descrição do ticket #${id}`;
    const firstResult = specValidator.validateSpec(description);
    const replies = firstResult.valid ? [] : await fetchSpecReplies(id);
    let { content, result, completedBy, completedByJournalIds } = withSpecReplies(description, firstResult, replies);
    let sourceLabel = completedBy
        ? `${baseLabel} + resposta de ${completedBy}`
        : (reviewed ? baseLabel : `${baseLabel} no Redmine`);
    let accepted = !result.valid && await specAccepted(id, replies);
    let proceed = result.valid || accepted;
    if (completedBy) console.log(`Ticket #${id}: spec completada por ${completedBy} — seguindo o ciclo.`);

    let repair = { pending: null, approved: null };
    if (!proceed) {
        repair = await handleSpecRepair(ticket, {
            content, result, replies, sourceLabel,
            specLocation: reviewed ? specRel : 'a descrição deste ticket',
            mergeBase: description, mergeTarget: `${REPO_PATH}/${specRel}`,
        });
        if (repair.approved) {
            ({ content, result } = repair.approved);
            accepted = !result.valid;
            proceed = true;
            sourceLabel += ` + seções sugeridas por IA e aprovadas por ${repair.approved.by} (${specRel})`;
        }
    }
    const approvedRepair = repair.approved ? { by: repair.approved.by, merged: repair.approved.merged, specRel } : null;
    if (DRY_RUN) return { result, accepted, proceed, sourceLabel, completedBy, pending: repair.pending, approvedRepair };

    if (proceed) removeSpecDraft(id);
    const signature = specValidator.specSignature(content, result);
    const previous = readSpecGate(id) || {};
    writeSpecGate(id, {
        ...previous,
        ticket_id: id,
        // Título: o dashboard mostra a pendência pré-task (sem state.json) a partir daqui.
        subject: ticket.subject || previous.subject,
        status: result.valid ? 'valid' : (accepted ? 'accepted' : (repair.pending ? 'spec-pending-approval' : 'spec-invalid')),
        source: reviewed ? 'generated_spec' : 'ticket_description',
        errors: result.errors,
        warnings: result.warnings,
        signature,
        completed_by: completedBy || undefined,
        completed_by_journal_ids: completedBy && completedByJournalIds.length ? completedByJournalIds : undefined,
        spec_pending_approval: repair.pending || undefined,
        spec_draft: undefined, // rascunho liberado (runSpecDraftGate já deixou passar)
        ...(repair.approved ? approvedRepairGateFields(repair.approved, specRel) : {}),
        checked_at: new Date().toISOString(),
    });
    if (!proceed && !repair.pending && !repair.failed) {
        await notifySpecInvalid(ticket, result, signature, {
            sourceLabel,
            fixInstruction: reviewed
                ? `Edite ${specRel} (ou responda aqui com um comentário) incluindo as seções que faltam.`
                : 'Edite a descrição deste ticket (ou responda aqui com um comentário) incluindo as seções que faltam.',
        });
    }
    return { result, accepted, proceed, sourceLabel, completedBy, pending: repair.pending, approvedRepair };
}

// Task ativa: valida memory/spec/<id>-spec.md do worktree (ou, se o fetch_ticket não
// chegou a escrever, a descrição do ticket) e sincroniza state.status: spec-invalid
// (ou spec-pending-approval, com draft do auto-repair no Redmine) enquanto incompleta e
// sem aceite; volta pra in_progress quando passar, for aceita ou o draft for aprovado.
// IDs AC-XX: a spec escrita pelo /fetch-ticket de um ciclo novo precisa deles (acIds
// 'require'); run anterior aos IDs (specValidator.isLegacyAcRun) só ganha aviso; a
// descrição crua do ticket nunca é cobrada. Passando, grava state.ac_ids (só os IDs —
// o texto fica na spec).
async function runTaskSpecGate(ticket, active) {
    const id = ticket.id;
    // Expectativas CAS antes dos awaits (Redmine/IA): o que este tick decidiu em cima.
    const gateSnap = active?.state ? cas.snapshotOf(active.state) : null;
    const specRel = `memory/spec/${id}-spec.md`;
    const specPath = `${worktreePathFor(REPO_PATH, id)}/${specRel}`;
    const fromFile = fs.existsSync(specPath);
    const fileOrDescription = fromFile ? fs.readFileSync(specPath, 'utf8') : (ticket.description || '');
    let sourceLabel = fromFile
        ? `${specRel} (worktree .claude/worktrees/${id} do consumidor)`
        : `descrição do ticket #${id} no Redmine (worktree sem ${specRel})`;
    // Spec sem spec_template_version (legada) segue as regras antigas. O aviso
    // SPEC_TEMPLATE_VERSION_MISSING fica no CLI (intake do /fetch-ticket), fora do
    // context.md: lá só entra o que muda o diagnóstico do /plan.
    const validateOpts = { acIds: !fromFile ? 'optional' : (specValidator.isLegacyAcRun(active.state) ? 'legacy' : 'require') };
    const firstResult = specValidator.validateSpec(fileOrDescription, validateOpts);
    const replies = firstResult.valid ? [] : await fetchSpecReplies(id);
    let { content, result, completedBy } = withSpecReplies(fileOrDescription, firstResult, replies, validateOpts);
    if (completedBy) sourceLabel += ` + resposta de ${completedBy}`;
    let accepted = !result.valid && await specAccepted(id, replies);
    let proceed = result.valid || accepted;

    let repair = { pending: null, approved: null };
    if (!proceed) {
        repair = await handleSpecRepair(ticket, {
            content, result, replies, sourceLabel,
            specLocation: fromFile ? `${specRel} (worktree do ticket)` : 'a descrição deste ticket',
            mergeBase: fileOrDescription, mergeTarget: specPath, validateOpts,
        });
        if (repair.approved) {
            ({ content, result } = repair.approved);
            accepted = !result.valid;
            proceed = true;
            sourceLabel = `${specRel} (worktree .claude/worktrees/${id} do consumidor) com seções sugeridas por IA e aprovadas por ${repair.approved.by}`;
        }
    }
    // Critério com [PENDING_CLARIFICATION]: a spec passa, mas o /plan não roda — nem com
    // "aceito" — até o marcador sair (docs/spec-guide.md).
    const clarification = proceed && result.pendingClarification?.length ? result.pendingClarification : null;
    if (clarification) proceed = false;
    const signature = specValidator.specSignature(content, result);
    if (DRY_RUN) return { result, accepted, proceed, sourceLabel, pending: repair.pending, clarification };

    const { state, dir } = active;
    const pending = proceed ? null : repair.pending;
    if (proceed) removeSpecDraft(id);
    const previousGate = readSpecGate(id);
    if (previousGate?.spec_pending_approval || pending || repair.approved) {
        writeSpecGate(id, {
            ...(previousGate || { ticket_id: id }),
            ...(pending ? { status: 'spec-pending-approval' } : {}),
            spec_pending_approval: pending || undefined,
            ...(repair.approved ? { status: result.valid ? 'valid' : 'accepted', ...approvedRepairGateFields(repair.approved, specRel) } : {}),
        });
    }
    const wantStatus = proceed
        ? (SPEC_GATE_STATUSES.has(state.status) ? 'in_progress' : state.status)
        : (pending ? 'spec-pending-approval' : 'spec-invalid');
    const pendingChanged = JSON.stringify(state.spec_pending_approval || null) !== JSON.stringify(pending);
    // IDs só de spec do worktree com IDs sem erro (aceite com ID quebrado não persiste lixo).
    const acIds = proceed && fromFile && result.acIds?.length && !result.errors.some(e => /^AC_/.test(e.code))
        ? result.acIds : null;
    const acIdsChanged = acIds && JSON.stringify(state.ac_ids || null) !== JSON.stringify(acIds);
    // Versão do template que a spec segue (rastreabilidade) — spec legada não grava nada.
    const templateVersion = fromFile && Number.isInteger(result.templateVersion) ? result.templateVersion : null;
    const templateVersionChanged = templateVersion !== null && state.spec_template_version !== templateVersion;
    if (wantStatus !== state.status || pendingChanged || acIdsChanged || templateVersionChanged) {
        state.status = wantStatus;
        if (pending) state.spec_pending_approval = pending;
        else delete state.spec_pending_approval;
        if (acIdsChanged) state.ac_ids = acIds;
        if (templateVersionChanged) state.spec_template_version = templateVersion;
        state.updated_at = new Date().toISOString();
        try {
            if (repair.approved && proceed && gateSnap) {
                // Aprovação humana do draft (spec_approval): idempotente pelo journal/assinatura
                // e CAS contra o que este tick leu antes dos awaits do Redmine.
                const res = cas.transact({
                    runDir: dir, operation: 'spec_approval', actor: 'watcher',
                    operation_id: `spec_approval:${repair.approved.journalId ?? signature}`,
                    expected_state_version: gateSnap.expected_state_version, expected_spec_hash: gateSnap.expected_spec_hash,
                }, () => state);
                if (res.state) Object.assign(state, res.state);
            } else {
                writeTaskState(dir, state, 'spec_gate');
            }
        } catch (e) {
            if (!cas.isConflict(e)) throw e;
            console.warn(`Task ${active.taskId}: ${e.message} — o run mudou durante o portão de spec; reavalio no próximo tick.`);
            return { result, accepted, proceed: false, sourceLabel, pending, clarification, conflict: e.code };
        }
        checkWrittenState(dir);
    }

    if (proceed) {
        syncSpecWarningsToContext(dir, result, sourceLabel, accepted);
    } else if (clarification) {
        await notifySpecClarification(ticket, result, signature, fromFile ? `${specRel} (worktree do ticket)` : 'a descrição deste ticket');
    } else if (!pending && !repair.failed) {
        await notifySpecInvalid(ticket, result, signature, {
            sourceLabel,
            fixInstruction: fromFile
                ? `Complete ${specRel} no worktree do ticket (ou atualize a descrição do ticket e peça pra spec ser regerada).`
                : 'Edite a descrição deste ticket incluindo as seções que faltam.',
        });
    }
    return { result, accepted, proceed, sourceLabel, pending, clarification };
}

// ---------------------------------------------------------------------------------
// Portão de qualidade do plano (scripts/lib/plan-scorer.js), entre plan e implement —
// ANTES do portão de build: plano que vai voltar pro /plan não precisa de mvn compile.
// Só heurística (nenhum LLM). Plano abaixo de PLAN_SCORE_THRESHOLD (padrão 60) volta
// pro /plan com o feedback no prompt, no máximo PLAN_MAX_REPLANS vezes; depois disso
// state.status='plan-escalation' e o watcher pede revisão humana no Redmine. Mesmo
// padrão dos outros portões: pausa + aceite leve ("aceito" no Redmine, ou a flag
// --aceitar-plano=<id>) — nunca exige que alguém reescreva o plano. Editar a seção
// "## Plano de execução" do handoff.md também destrava, se o score passar.
//
// state.json: planScore/planFeedback/planAttempts (re-plans já despachados, 0 = plano
// original), planSignature (hash do plano avaliado), planAccepted {signature, by, at}.
const PLAN_MAX_REPLANS = 2;
const PLAN_GATE_COMMENT_PREFIX = '[Watcher] Plano abaixo do score mínimo';

function needsPlanGate(state) {
    if (!state) return false;
    if (state.status === 'plan-escalation') return true;
    const history = state.history || [];
    return state.node === 'implement' && history[history.length - 1] === 'plan';
}

// Plano = plan.md (artefato do HOW que o /plan escreve e nenhum nó seguinte reescreve —
// ver scripts/lib/spec-authority.js); runs anteriores a ele: handoff.md, e context.md só
// se o handoff não tiver passos. Spec = memory/spec/<id>-spec.md do worktree, ou a descrição.
function readPlanArtifacts(ticket, dir) {
    const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
    const plan = read(`${dir}/plan.md`);
    const handoff = read(`${dir}/handoff.md`);
    const context = read(`${dir}/context.md`);
    const usePlan = planScorer.extractSteps(plan).steps.length > 0;
    const useContext = !usePlan && !planScorer.extractSteps(handoff).steps.length && planScorer.extractSteps(context).steps.length > 0;
    const specPath = `${worktreePathFor(REPO_PATH, ticket.id)}/memory/spec/${ticket.id}-spec.md`;
    return {
        planContent: usePlan ? plan : useContext ? context : handoff,
        planFile: usePlan ? 'plan.md' : useContext ? 'context.md' : 'handoff.md',
        specContent: fs.existsSync(specPath) ? read(specPath) : (ticket.description || ''),
    };
}

async function planAcceptedBy(ticketId) {
    if (ACCEPT_PLAN_IDS.has(ticketId)) return 'flag --aceitar-plano';
    let journals = [];
    try {
        const res = await redmineFetch(`${REDMINE_URL}/issues/${ticketId}.json?include=journals`,
            { headers: { 'X-Redmine-API-Key': REDMINE_API_KEY } });
        if (res.ok) journals = (await res.json()).issue?.journals || [];
    } catch (e) {
        console.error(`Falha lendo comentários do Redmine #${ticketId} pra checar aceite do plano:`, e.message);
        return null;
    }
    const notes = journals.filter(j => j.notes && j.notes.trim());
    const askedAt = notes.map(j => j.notes.trim().startsWith(PLAN_GATE_COMMENT_PREFIX)).lastIndexOf(true);
    if (askedAt === -1) return null;
    const answer = notes.slice(askedAt + 1).find(j => !specValidator.isWatcherNote(j.notes) && specValidator.isAcceptanceNote(j.notes));
    return answer ? `${answer.user?.name || '?'} (Redmine, ${answer.created_on})` : null;
}

function formatPlanEscalationComment(ticket, taskId, result, planFile) {
    return (
        `${PLAN_GATE_COMMENT_PREFIX} — ticket #${ticket.id} (task ${taskId}).\n\n` +
        `Score do plano: ${result.score}/100 (mínimo ${result.threshold}), ainda insuficiente depois de ` +
        `${PLAN_MAX_REPLANS} re-plans automáticos. O watcher parou antes do Implement e pede uma revisão humana do ` +
        `plano (memory/runs/${taskId}/${planFile} no worktree .claude/worktrees/${ticket.id} do consumidor).\n\n` +
        `Pontos que o score apontou:\n${result.feedback.map(f => `- ${f}`).join('\n')}\n\n` +
        `Para seguir pro Implement com este plano, responda com um comentário começando por "aceito" ` +
        `(ou rode o watcher com --aceitar-plano=${ticket.id}). Se preferir ajustar, edite a seção ` +
        `"## Plano de execução" do ${planFile} — o watcher reavalia a cada ciclo e segue sozinho quando o score passar.`
    );
}

// Pro prompt do re-plan: o que o score apontou no plano anterior.
function planFeedbackNote(state) {
    const feedback = Array.isArray(state.planFeedback) ? state.planFeedback : [];
    if (!(state.planAttempts > 0) || !feedback.length || state.status === 'plan-escalation') return '';
    return (
        ` RE-PLAN ${state.planAttempts}/${PLAN_MAX_REPLANS}: o plano anterior teve score ${state.planScore}/100 no portão de ` +
        `qualidade do watcher (mínimo ${state.planScoreThreshold ?? planScorer.thresholdFrom()}) e voltou pra este nó. Reescreva a ` +
        `seção "## Plano de execução" do plan.md (runs antigos sem plan.md: do handoff.md) resolvendo cada ponto abaixo (entre ${planScorer.MIN_STEPS} e ` +
        `${planScorer.MAX_STEPS} passos numerados, cada um com "Arquivo:", "Critérios: AC-XX" e "Verificação:", cobrindo todos ` +
        `os Critérios de Aceite da spec pelos IDs dela — sem citar AC que a spec não tem — e sem contrariar as Restrições) ` +
        `e grave node="implement" ao terminar:\n` +
        `${feedback.map(f => `- ${f}`).join('\n')}\n`
    );
}

// Devolve { proceed: true } (segue pro implement), { proceed: false, replan: true }
// (state.node já voltou pra "plan") ou { proceed: false, reason: 'plan_escalation' }.
async function runPlanGate(ticket, active) {
    const { taskId, state, dir } = active;
    const { planContent, specContent, planFile } = readPlanArtifacts(ticket, dir);
    const signature = planScorer.planSignature(planContent);
    const result = planScorer.scorePlan(planContent, specContent);
    const attempts = Number.isInteger(state.planAttempts) ? state.planAttempts : 0;
    const now = () => new Date().toISOString();
    const stamp = (extra = {}) => Object.assign(state, {
        planScore: result.score, planFeedback: result.feedback, planAttempts: attempts,
        planScoreThreshold: result.threshold, planSignature: signature, updated_at: now(),
    }, extra);
    const resume = () => { state.status = 'in_progress'; state.node = 'implement'; };

    if (DRY_RUN) {
        console.log(`[dry-run] Task ${taskId}: score do plano ${result.score}/100 (mínimo ${result.threshold}).`);
        return { proceed: result.passed || state.planAccepted?.signature === signature, result };
    }

    // Plano aceito por humano numa escalada anterior — não reavalia o mesmo texto.
    if (state.planAccepted?.signature === signature) {
        if (state.status === 'plan-escalation') { resume(); writeTaskState(dir, state); }
        return { proceed: true, result, accepted: state.planAccepted.by };
    }

    if (result.passed) {
        const changed = state.planSignature !== signature || state.planScore !== result.score || state.status === 'plan-escalation';
        if (changed) {
            stamp();
            if (state.status === 'plan-escalation') resume();
            writeTaskState(dir, state);
        }
        console.log(`Task ${taskId}: plano com score ${result.score}/100 (mínimo ${result.threshold}) — segue pro implement.`);
        return { proceed: true, result };
    }

    if (state.status === 'plan-escalation') {
        const by = await planAcceptedBy(ticket.id);
        if (by) {
            stamp({ planAccepted: { signature, by, at: now() } });
            resume();
            writeTaskState(dir, state);
            console.log(`Task ${taskId}: plano com score ${result.score}/100 aceito por ${by} — segue pro implement.`);
            return { proceed: true, result, accepted: by };
        }
        if (state.planSignature !== signature || !state.planEscalationNotifiedAt) {
            stamp();
            if (!state.planEscalationNotifiedAt && await postRedmineNote(ticket.id, formatPlanEscalationComment(ticket, taskId, result, planFile))) {
                state.planEscalationNotifiedAt = now();
            }
            writeTaskState(dir, state);
        }
        return { proceed: false, reason: 'plan_escalation', result };
    }

    state.events = Array.isArray(state.events) ? state.events : [];
    if (attempts < PLAN_MAX_REPLANS) {
        stamp({ planAttempts: attempts + 1, node: 'plan' });
        state.events.push({ type: 'plan_replan', node: 'plan', at: now(), detail: `score ${result.score}/${result.threshold} — re-plan ${attempts + 1}/${PLAN_MAX_REPLANS}` });
        writeTaskState(dir, state);
        console.warn(`Task ${taskId}: plano com score ${result.score}/100 (mínimo ${result.threshold}) — re-plan ${attempts + 1}/${PLAN_MAX_REPLANS}. ${result.feedback.join(' ')}`);
        return { proceed: false, replan: true, result };
    }

    stamp({ status: 'plan-escalation', node: 'plan' });
    delete state.planEscalationNotifiedAt;
    state.events.push({ type: 'plan_escalation', node: 'plan', at: now(), detail: `score ${result.score}/${result.threshold} após ${PLAN_MAX_REPLANS} re-plans` });
    if (await postRedmineNote(ticket.id, formatPlanEscalationComment(ticket, taskId, result, planFile))) {
        state.planEscalationNotifiedAt = now();
    }
    writeTaskState(dir, state);
    console.warn(`Task ${taskId}: plano ainda com score ${result.score}/100 após ${PLAN_MAX_REPLANS} re-plans — plan-escalation, revisão humana pedida no Redmine.`);
    return { proceed: false, reason: 'plan_escalation', result };
}

// Portão de drift da spec (scripts/lib/spec-authority.js). SPEC = WHAT: implement,
// review, test e verify só rodam sobre a spec que o /plan leu (state.spec_hash) — ou
// sobre uma versão nova explicitamente aprovada (spec_change_approved === true e
// spec_change_hash === hash atual). Qualquer outro caso: status="spec-drift", evento
// spec_drift, um comentário no Redmine por versão da spec, e o ciclo para. Retoma
// sozinho quando a aprovação é gravada no state.json, a spec volta ao hash do Plan, ou
// um humano devolve a task pro /plan (node="plan"). Sem spec_hash (run anterior a
// isto, ou /plan que não gravou), grava o baseline e segue (evento spec_baseline).
const SPEC_DRIFT_COMMENT_PREFIX = '[Watcher] Spec alterada durante a execução';

function formatSpecDriftComment(ticket, taskId, node, result) {
    return (
        `${SPEC_DRIFT_COMMENT_PREFIX} — ticket #${ticket.id} (task ${taskId}).\n\n` +
        `O pipeline parou antes do /${node}: ${result.reason}.\n\n` +
        `A spec é a autoridade do WHAT (critérios de aceite, restrições, comportamento); nenhum nó depois do Plan ` +
        `pode seguir sobre uma spec diferente da que o Plan leu sem aprovação explícita. ` +
        `${specAuthority.approvalHint(result)}`
    );
}

async function runSpecDriftGate(ticket, active, node) {
    const { taskId, state, dir } = active;
    const root = path.resolve(dir, '..', '..', '..');
    // --dry-run não escreve nada: baseline tardio e aprovação manual gravam o changelog da
    // spec dentro do enforceSpecIntegrity, então ficam só no checkDrift; o resto roda numa cópia.
    const probe = DRY_RUN && node !== 'plan' ? specAuthority.checkDrift(state, { root, taskId }) : null;
    if (probe && (probe.status === 'no_baseline' || probe.status === 'approved')) {
        console.log(`[dry-run] Task ${taskId}: gravaria state.json (e o changelog da spec, se versionada): spec integrity — ${probe.reason}.`);
        return { proceed: true, result: probe };
    }
    const outcome = specAuthority.enforceSpecIntegrity(DRY_RUN ? structuredClone(state) : state, { root, taskId, node });
    if (outcome.changed) {
        if (DRY_RUN) console.log(`[dry-run] Task ${taskId}: gravaria state.json: spec integrity — ${outcome.message}.`);
        else writeTaskState(dir, state);
        if (outcome.proceed) console.log(`Task ${taskId}: ${outcome.message}`);
    }
    if (outcome.proceed) return { proceed: true, result: outcome.result };
    const notified = state.spec_drift?.notified_hash === (outcome.result.currentHash || 'removed');
    console.warn(`Task ${taskId}: SPEC DRIFT antes de ${node} — ${outcome.message}. ${specAuthority.approvalHint(outcome.result)}`);
    if (!DRY_RUN && !notified && await postRedmineNote(ticket.id, formatSpecDriftComment(ticket, taskId, node, outcome.result))) {
        state.spec_drift.notified_hash = outcome.result.currentHash || 'removed';
        writeTaskState(dir, state);
    }
    return { proceed: false, result: outcome.result };
}

// Portão de SPEC_CHANGE (scripts/lib/spec-change.js). O /implement, ao descobrir que
// uma decisão muda requisito funcional, não a aprova: grava a proposta em
// spec-change-audit.json e pausa (status spec-change-pending-approval). Aqui, a mesma
// infraestrutura de aprovação do spec-pending-approval: um comentário no Redmine com a
// proposta (uma vez por proposta) e, nos ticks seguintes, a primeira resposta começando
// por SPEC_APPROVAL_KEYWORD (aprova: spec + Histórico de Mudanças, spec_hash novo,
// artefatos stale, task volta pro /plan) ou SPEC_REJECTION_KEYWORD (rejeita: segue
// pausada em spec-change-rejected até um humano decidir). O botão do dashboard posta a
// mesma palavra-chave (POST /api/redmine/comment).
const SPEC_CHANGE_COMMENT_PREFIX = '[Watcher] SPEC_CHANGE proposta';
const SPEC_REJECTION_KEYWORD = specValidator.rejectionKeyword();

function formatSpecChangeComment(ticket, taskId, p) {
    return [
        `${SPEC_CHANGE_COMMENT_PREFIX} ${p.id} — ticket #${ticket.id} (task ${taskId}).`,
        '',
        'Durante a implementação o agente encontrou uma decisão que muda requisito funcional. Ele NÃO pode aprová-la sozinho: o pipeline está pausado.',
        '',
        `* ACs afetados: ${p.ac_affected?.length ? p.ac_affected.join(', ') : '(nenhum AC específico — regra/restrição/escopo)'}`,
        `* Comportamento atual (spec): ${p.previous_behavior}`,
        `* Comportamento proposto: ${p.proposed_behavior}`,
        `* Motivo: ${p.rationale}`,
        `* Proposto por: ${p.agent} em ${p.timestamp}`,
        ...(p.reclassified_reason ? [`* Reclassificação automática: ${p.reclassified_reason}`] : []),
        '',
        `Para aprovar, responda com um comentário começando por *${SPEC_APPROVAL_KEYWORD}*: a spec ganha a entrada no "Histórico de Mudanças" e a task volta para o /plan (o HOW é refeito sobre a spec nova).`,
        `Para rejeitar, comece por *${SPEC_REJECTION_KEYWORD}*: a spec não muda e a task fica pausada até alguém decidir implementar o critério como está.`,
    ].join('\n');
}

// Substitui o conteúdo de `state` (objeto compartilhado com o resto do despacho) pelo
// state.json do disco — depois de aprovar/rejeitar, que gravam o arquivo direto.
function reloadState(dir, state) {
    const fresh = readTaskState(dir);
    for (const k of Object.keys(state)) delete state[k];
    Object.assign(state, fresh);
}

async function runSpecChangeGate(ticket, active) {
    const { taskId, state, dir } = active;
    // Expectativas CAS da decisão humana, antes dos awaits do Redmine (scripts/cas.js).
    const snap = cas.snapshotOf(state);
    const decisionExpect = () => ({
        expected_state_version: snap.expected_state_version, expected_spec_hash: snap.expected_spec_hash,
        operation_id: state.spec_change_pending?.id ? `${state.spec_change_pending.id}@${taskId}` : undefined,
    });
    if (state.status === specChange.REJECTED_STATUS) {
        const r = state.spec_change_rejected || {};
        console.warn(`Task ${taskId}: SPEC_CHANGE ${r.id || '?'} rejeitada por ${r.rejector || '?'} — pausada até decisão humana (mensagem pelo dashboard dizendo como seguir, ou node="implement", status="in_progress" no state.json).`);
        return { proceed: false, reason: 'spec_change_rejeitada' };
    }
    const pending = state.spec_change_pending;
    if (!pending) {
        console.warn(`Task ${taskId}: status ${specChange.PENDING_STATUS} sem spec_change_pending no state.json — corrija o state (ou rode o /implement de novo).`);
        return { proceed: false, reason: 'spec_change_sem_proposta' };
    }
    if (!pending.posted_at) {
        if (DRY_RUN) {
            console.log(`[dry-run] Task ${taskId}: comentaria a SPEC_CHANGE ${pending.id} no Redmine #${ticket.id} e esperaria "${SPEC_APPROVAL_KEYWORD}"/"${SPEC_REJECTION_KEYWORD}".`);
            return { proceed: false, reason: 'spec_change_aguardando_aprovacao' };
        }
        const postedAt = new Date().toISOString();
        if (await postRedmineNote(ticket.id, formatSpecChangeComment(ticket, taskId, pending))) {
            const commentId = await findJournalId(ticket.id, SPEC_CHANGE_COMMENT_PREFIX);
            Object.assign(pending, { comment_id: commentId, posted_at: postedAt, keyword: SPEC_APPROVAL_KEYWORD, rejection_keyword: SPEC_REJECTION_KEYWORD });
            state.updated_at = postedAt;
            writeTaskState(dir, state, 'spec_change_posted');
            console.warn(`Task ${taskId}: SPEC_CHANGE ${pending.id} (${pending.ac_affected?.join(', ') || 'sem AC'}) publicada no Redmine #${ticket.id} — aguardando "${SPEC_APPROVAL_KEYWORD}" ou "${SPEC_REJECTION_KEYWORD}".`);
        }
        return { proceed: false, reason: 'spec_change_aguardando_aprovacao' };
    }
    const replies = await fetchRepliesAfter(ticket.id, [SPEC_CHANGE_COMMENT_PREFIX], 'checar decisão da SPEC_CHANGE');
    const reply = findApprovalReply(replies, pending, {
        approveKeyword: pending.keyword || SPEC_APPROVAL_KEYWORD, rejectKeyword: pending.rejection_keyword || SPEC_REJECTION_KEYWORD,
    });
    if (!reply) {
        console.log(`Task ${taskId}: SPEC_CHANGE ${pending.id} aguardando decisão humana no Redmine #${ticket.id}.`);
        return { proceed: false, reason: 'spec_change_aguardando_aprovacao' };
    }
    if (DRY_RUN) {
        console.log(`[dry-run] Task ${taskId}: SPEC_CHANGE ${pending.id} ${reply.decision === 'approved' ? 'aprovada' : 'rejeitada'} por ${reply.by} — não aplico em dry-run.`);
        return { proceed: false, reason: 'spec_change_aguardando_aprovacao' };
    }
    if (reply.decision === 'rejected') {
        const out = specChange.rejectSpecChange(dir, { by: reply.by, reason: reply.journal.notes.trim().replace(/^\S+\s*/, '').slice(0, 500) || undefined, expect: decisionExpect() });
        if (out.status === 'already_processed') { reloadState(dir, state); return { proceed: false, reason: 'spec_change_rejeitada' }; }
        if (!out.ok) { console.error(`Task ${taskId}: falha registrando a rejeição da SPEC_CHANGE: ${out.error}`); return { proceed: false, reason: 'spec_change_aguardando_aprovacao' }; }
        reloadState(dir, state);
        checkWrittenState(dir);
        console.warn(`Task ${taskId}: SPEC_CHANGE ${pending.id} rejeitada por ${reply.by} — spec inalterada, pipeline pausado.`);
        return { proceed: false, reason: 'spec_change_rejeitada' };
    }
    const out = specChange.approveSpecChange(dir, { by: reply.by, approvalJournalId: Number.isInteger(reply.journal?.id) ? reply.journal.id : null, expect: decisionExpect() });
    if (out.status === 'already_processed') {
        console.log(`Task ${taskId}: SPEC_CHANGE ${pending.id} já aplicada antes (already_processed) — nada a refazer.`);
        reloadState(dir, state);
        return { proceed: true };
    }
    if (!out.ok) { console.error(`Task ${taskId}: falha aplicando a SPEC_CHANGE aprovada: ${out.error}`); return { proceed: false, reason: 'spec_change_aguardando_aprovacao' }; }
    reloadState(dir, state);
    checkWrittenState(dir);
    const invalidated = out.invalidation?.case !== 'unchanged';
    console.log(`Task ${taskId}: SPEC_CHANGE ${pending.id} aprovada por ${reply.by} — spec atualizada (spec_hash ${String(out.specHash || '—').slice(0, 12)}), ` +
        (invalidated ? `artefatos derivados STALE, task volta pro /plan` : `HASH_SCOPE inalterado, nada invalidado, task retoma o /${state.node}`) +
        (out.propagated?.length ? `; propagada para ${out.propagated.map(p => `${p.task} (${p.case})`).join(', ')}` : '') + '.');
    await postRedmineNote(ticket.id, invalidated
        ? `[Watcher] SPEC_CHANGE ${pending.id} aprovada por ${reply.by}. Spec atualizada (Histórico de Mudanças) e a task voltou para o /plan — o plano é refeito sobre a spec nova.`
        : `[Watcher] SPEC_CHANGE ${pending.id} aprovada por ${reply.by}. Spec atualizada só fora do contrato (Histórico de Mudanças): nenhum artefato invalidado, a task retoma o /${state.node}.`);
    return { proceed: true };
}

// Portão de build pré-implement (scripts/lib/build-validator.js). Roda `mvn compile`
// no worktree depois que o /plan termina (state.node === "implement") e ANTES de
// despachar o /implement — sem isto o agente era despachado em cima de uma base que
// já não compilava e gastava a execução nos erros de outra pessoa. Só compila (nunca
// testa). Desliga com SKIP_PRE_BUILD_VALIDATION=true (preBuildStatus="skipped").
//
// Falhou: state.status="pre-build-failed", preBuildErrors no state.json, um comentário
// no Redmine com os erros (sempre — inclusive em --follow: é o registro que fica no
// ticket) e o ciclo para. Nos ticks seguintes:
//   - aceite ("aceito" no Redmine depois do comentário, ou --aceitar-build=<id>):
//     despacha o implement com os erros no prompt (caso "o ticket É corrigir isto" —
//     ver memory feedback: portões pedem aceite, não bloqueiam pra sempre);
//   - worktree mudou (HEAD ou diff, fora de memory/): recompila sozinho;
//   - senão continua parado sem rodar Maven de novo (mvn a cada tick de cron = caro).
// Humano que volta status pra "in_progress" à mão também força recompilar.
// Problema de ambiente (Maven ausente, JDK incompatível com o release do pom, jar de
// repo irmão desatualizado no ~/.m2 — ver build-validator.staleDependencies) não diz
// nada sobre o código: vira "skipped" com preBuildSkipReason e aviso no log.
const PRE_BUILD_COMMENT_PREFIX = '[Watcher] Validação de build pré-implement falhou';
const PRE_BUILD_MAX_COMMENT_ERRORS = 30;

function needsPreBuildGate(state) {
    if (!state || state.node !== 'implement') return false;
    if (state.status === 'pre-build-failed') return true;
    // Já passou por um implement (ex: review reprovou e voltou): o worktree tem mudança
    // em andamento do próprio agente — compilar aqui não diz nada sobre a base.
    if ((state.history || []).includes('implement')) return false;
    if (!state.preBuildStatus) return true;
    return state.preBuildStatus === 'failed' && !state.preBuildAccepted;
}

const worktreeFingerprint = buildValidator.worktreeFingerprint;

function preBuildNotifiedMarkerPath(dir) {
    return `${dir}/.pre-build-notified.json`;
}

function preBuildCommandText() {
    return process.env.PRE_BUILD_COMMAND || 'comando de pré-build do consumidor';
}

function formatPreBuildComment(ticket, taskId, result) {
    const shown = result.errors.slice(0, PRE_BUILD_MAX_COMMENT_ERRORS);
    const more = result.errors.length - shown.length;
    return (
        `${PRE_BUILD_COMMENT_PREFIX} — ticket #${ticket.id} (task ${taskId}).\n\n` +
        `\`${preBuildCommandText()}\` no worktree .claude/worktrees/${ticket.id} falhou em ` +
        `${Math.round(result.duration / 1000)}s, depois do /plan e ANTES de qualquer implementação: a base já não ` +
        `compila, então o nó implement não foi despachado.\n\n` +
        `Erros (${result.errors.length}):\n<pre>\n${shown.join('\n')}${more > 0 ? `\n… e mais ${more} (ver preBuildErrors no state.json)` : ''}\n</pre>\n\n` +
        `Para seguir: corrija a base (ex: merge/rebase da branch base com o fix) — o watcher recompila sozinho no ` +
        `próximo tick quando o worktree mudar; ou responda com um comentário começando por "aceito" para despachar o ` +
        `implement assim mesmo (ex: quando o próprio ticket é corrigir esse erro).`
    );
}

// Idempotente por conjunto de erros; só marca como notificado se o PUT deu certo.
async function notifyPreBuildFailed(ticket, taskId, dir, result) {
    const signature = crypto.createHash('sha1').update(result.errors.join('\n')).digest('hex');
    const markerPath = preBuildNotifiedMarkerPath(dir);
    if (alreadyNotified(markerPath, signature)) return;
    if (await postRedmineNote(ticket.id, formatPreBuildComment(ticket, taskId, result))) markNotified(markerPath, signature);
}

// Aceite da falha: flag --aceitar-build, ou comentário não-watcher começando por
// "aceito" feito DEPOIS do último comentário de falha do portão.
async function preBuildAccepted(ticketId) {
    if (ACCEPT_BUILD_IDS.has(ticketId)) return 'flag --aceitar-build';
    let journals = [];
    try {
        const res = await redmineFetch(`${REDMINE_URL}/issues/${ticketId}.json?include=journals`,
            { headers: { 'X-Redmine-API-Key': REDMINE_API_KEY } });
        if (res.ok) journals = (await res.json()).issue?.journals || [];
    } catch (e) {
        console.error(`Falha lendo comentários do Redmine #${ticketId} pra checar aceite do pré-build:`, e.message);
        return null;
    }
    const notes = journals.filter(j => j.notes && j.notes.trim());
    const askedAt = notes.map(j => j.notes.trim().startsWith(PRE_BUILD_COMMENT_PREFIX)).lastIndexOf(true);
    if (askedAt === -1) return null;
    const answer = notes.slice(askedAt + 1).find(j => !specValidator.isWatcherNote(j.notes) && specValidator.isAcceptanceNote(j.notes));
    return answer ? `${answer.user?.name || '?'} (Redmine, ${answer.created_on})` : null;
}

function preBuildAcceptedNote(state) {
    const errors = state.preBuildErrors || [];
    return (
        ` A validação de build pré-implement (\`${preBuildCommandText()}\`) FALHOU antes deste nó e o usuário aceitou ` +
        `seguir assim mesmo. Estes erros já existiam na base, antes de qualquer mudança sua — não os confunda com ` +
        `erros introduzidos por você; corrija-os só se fizerem parte do escopo do ticket:\n${errors.join('\n')}\n`
    );
}

// Só "running" com o agente vivo — dashboard que caiu no meio não prende o ticket.
function preBuildAiFixRunning(state) {
    const f = state.preBuildAiFix;
    if (f?.status !== 'running' || !Number.isInteger(f.pid) || f.pid <= 0) return false;
    try { process.kill(f.pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Devolve { proceed, reason?, note } — note vai pro prompt do implement.
async function runPreBuildGate(ticket, active, worktreePath, { validate = buildValidator.validateBuild, env = process.env } = {}) {
    const { taskId, dir } = active;
    const now = () => new Date().toISOString();
    let state = readTaskState(dir);

    // "✨ Corrigir com IA" do dashboard em andamento: o agente está editando o worktree,
    // recompilar agora (fingerprint muda a cada edição) ou despachar o implement
    // atropelaria a correção. Quem grava o veredito no fim é o dashboard.
    if (state.status === 'pre-build-failed' && preBuildAiFixRunning(state)) {
        console.log(`Task ${taskId}: correção do build por IA em andamento (dashboard) — aguardando.`);
        return { proceed: false, reason: 'pre_build_ai_fix' };
    }

    if (buildValidator.skipRequested(env)) {
        if (state.preBuildStatus !== 'skipped' || state.status === 'pre-build-failed') {
            Object.assign(state, { preBuildStatus: 'skipped', preBuildDurationMs: 0, preBuildAt: now(), updated_at: now() });
            delete state.preBuildErrors;
            if (state.status === 'pre-build-failed') state.status = 'in_progress';
            writeTaskState(dir, state);
        }
        console.log(`Task ${taskId}: validação de build pré-implement desligada (SKIP_PRE_BUILD_VALIDATION=true).`);
        return { proceed: true, note: '' };
    }

    if (state.status === 'pre-build-failed') {
        const acceptedBy = await preBuildAccepted(ticket.id);
        if (acceptedBy) {
            Object.assign(state, { status: 'in_progress', preBuildAccepted: { at: now(), by: acceptedBy }, updated_at: now() });
            writeTaskState(dir, state);
            console.log(`Task ${taskId}: falha do pré-build aceita por ${acceptedBy} — despachando implement com os erros no prompt.`);
            return { proceed: true, note: preBuildAcceptedNote(state) };
        }
        // Mesmo worktree E mesmo JDK => o resultado seria o mesmo. JDK diferente (ou não
        // registrado: falha anterior à resolução de JDK, ex #43646) recompila.
        const fp = worktreeFingerprint(worktreePath);
        const javaHome = buildValidator.resolveJavaHome(worktreePath, env).javaHome || null;
        if (fp && fp === state.preBuildFingerprint && 'preBuildJavaHome' in state && state.preBuildJavaHome === javaHome) {
            // Comentário que falhou no tick anterior (rede) é retentado aqui.
            await notifyPreBuildFailed(ticket, taskId, dir, { errors: state.preBuildErrors || [], duration: state.preBuildDurationMs || 0 });
            console.warn(`Task ${taskId}: build pré-implement quebrado e worktree sem mudança — aguardando correção ou "aceito" no Redmine.`);
            return { proceed: false, reason: 'pre_build_falhou' };
        }
    }

    console.log(`Task ${taskId}: validando build antes do implement (${preBuildCommandText()})...`);
    const siblingRepos = SIBLING_REPOS.map(r => `${WORKSPACE}/${r}`).filter(p => fs.existsSync(p));
    const result = await validate(worktreePath, { env, siblingRepos });
    state = readTaskState(dir); // Maven leva até minutos — relê antes de mesclar.
    const outcome = buildValidator.applyResult(state, result, {
        fingerprint: result.success || result.infraError ? null : worktreeFingerprint(worktreePath),
    });
    writeTaskState(dir, state);
    if (outcome === 'proceed') {
        if (result.success) console.log(`Task ${taskId}: build pré-implement OK em ${(result.duration / 1000).toFixed(1)}s.`);
        else console.warn(`Task ${taskId}: validação de build pré-implement PULADA — ${result.errors.join('; ')}. Sigo pro implement.`);
        return { proceed: true, note: '' };
    }
    console.warn(`Task ${taskId}: build pré-implement FALHOU (${result.errors.length} erro(s)) — implement não despachado.`);
    await notifyPreBuildFailed(ticket, taskId, dir, result);
    return { proceed: false, reason: 'pre_build_falhou' };
}

// Portão de churn de implementação (scripts/lib/churn-detector.js). Antes do 1º
// implement do ciclo grava a âncora (refs/churn/<taskId>/start); antes de cada
// RE-implement (history já tem "implement": review/test reprovou e voltou) grava o
// snapshot da rodada que acabou (refs/churn/<taskId>/rounds) e conta quantas rodadas
// mexeram em cada arquivo. Algum arquivo em >= CHURN_THRESHOLD rodadas (padrão 3;
// dobrado pra teste) => status="churn-escalation", churnReport no state.json,
// relatório no Redmine e o ciclo para antes de mais uma rodada.
//
// Como os demais portões, pede aceite em vez de travar pra sempre: "aceito" no Redmine
// depois do relatório (ou --aceitar-churn=<id>) volta pra in_progress e despacha o
// implement; as contagens aceitas viram baseline (churnAccepted.counts) e o mesmo
// arquivo só escala de novo se acumular mais CHURN_THRESHOLD rodadas depois do aceite.
// Task anterior ao portão (sem âncora) ganha âncora no primeiro re-implement e só
// passa a contar dali. Falha de git nunca bloqueia o ciclo — loga e segue.
const CHURN_COMMENT_PREFIX = '[Watcher] Churn de implementação detectado';
const CHURN_MAX_COMMENT_COMMITS = 5;

function churnRoundMessage(state, round) {
    const note = (lastAgentNote(state) || '').split('\n').map(l => l.trim()).find(Boolean) || '';
    const last = (state.history || []).filter(n => n !== 'implement').slice(-1)[0];
    const why = note ? `: ${note.slice(0, 120)}` : last ? ` (voltou do ${last})` : '';
    return `implement #${round}${why}`;
}

function formatChurnComment(ticket, taskId, report, threshold) {
    const rows = report.files.map(f =>
        `* @${f.path}@ — modificado em *${f.modificationCount}* rodadas (limite ${f.threshold}${churnDetector.isTestFile(f.path) ? ', dobrado por ser teste' : ''})\n` +
        f.commits.slice(0, CHURN_MAX_COMMENT_COMMITS).map(c => `** ${c}`).join('\n'));
    return (
        `${CHURN_COMMENT_PREFIX} — ticket #${ticket.id} (task ${taskId}).\n\n` +
        `O ciclo voltou pro Implement de novo e ${report.files.length === 1 ? 'um arquivo foi modificado' : `${report.files.length} arquivos foram modificados`} ` +
        `em ${threshold} ou mais rodadas de implement sem convergir (arquivos de teste: ${threshold * 2}). Isso costuma indicar ` +
        `conflito entre a spec e o código existente que o agente não consegue resolver sozinho — o watcher parou antes de ` +
        `mais uma rodada.\n\n` +
        `Arquivos em churn (mensagens das últimas rodadas que os tocaram):\n${rows.join('\n')}\n\n` +
        `Sugestão: compare o que as rodadas mudaram nesses arquivos (\`git log -p ${churnDetector.anchorRef(taskId)}..${churnDetector.roundsRef(taskId)} -- <arquivo>\` ` +
        `no worktree .claude/worktrees/${ticket.id} do consumidor) e o motivo das reprovações em memory/runs/${taskId}/. Em geral, ` +
        `o caminho é esclarecer a spec (critério de aceite ou restrição que conflita com o código atual) ou ajustar o plano ` +
        `antes de continuar.\n\n` +
        `Para seguir mesmo assim com mais rodadas de implement, responda com um comentário começando por "aceito" ` +
        `(ou rode o watcher com --aceitar-churn=${ticket.id}).`
    );
}

async function churnAcceptedBy(ticketId) {
    if (ACCEPT_CHURN_IDS.has(ticketId)) return 'flag --aceitar-churn';
    let journals = [];
    try {
        const res = await redmineFetch(`${REDMINE_URL}/issues/${ticketId}.json?include=journals`,
            { headers: { 'X-Redmine-API-Key': REDMINE_API_KEY } });
        if (res.ok) journals = (await res.json()).issue?.journals || [];
    } catch (e) {
        console.error(`Falha lendo comentários do Redmine #${ticketId} pra checar aceite do churn:`, e.message);
        return null;
    }
    const notes = journals.filter(j => j.notes && j.notes.trim());
    const askedAt = notes.map(j => j.notes.trim().startsWith(CHURN_COMMENT_PREFIX)).lastIndexOf(true);
    if (askedAt === -1) return null;
    const answer = notes.slice(askedAt + 1).find(j => !specValidator.isWatcherNote(j.notes) && specValidator.isAcceptanceNote(j.notes));
    return answer ? `${answer.user?.name || '?'} (Redmine, ${answer.created_on})` : null;
}

function needsChurnGate(state) {
    return !!state && state.node === 'implement';
}

// Devolve { proceed: true } ou { proceed: false, reason: 'churn_escalation', report }.
async function runChurnGate(ticket, active, worktreePath, { env = process.env } = {}) {
    const { taskId, dir } = active;
    const now = () => new Date().toISOString();
    const state = readTaskState(dir);
    const history = state.history || [];
    const escalated = state.status === 'churn-escalation';
    const threshold = churnDetector.resolveThreshold(env);
    try {
        if (!churnDetector.isGitWorktree(worktreePath)) return { proceed: true };
        const hadAnchor = !!churnDetector.resolveRef(worktreePath, churnDetector.anchorRef(taskId));
        if (!history.includes('implement') && !escalated) {
            churnDetector.ensureAnchor(worktreePath, taskId);
            return { proceed: true };
        }
        if (!hadAnchor) {
            churnDetector.ensureAnchor(worktreePath, taskId);
            console.log(`[churn] Task ${taskId}: task anterior ao portão de churn — âncora gravada agora, contagem começa nesta rodada.`);
            return { proceed: true };
        }
        if (!escalated) {
            const round = history.filter(n => n === 'implement').length;
            churnDetector.recordRound(worktreePath, taskId, churnRoundMessage(state, round));
        }
        const head = churnDetector.roundsRef(taskId);
        if (!churnDetector.resolveRef(worktreePath, head)) return { proceed: true };
        const result = await churnDetector.detectChurn(worktreePath, threshold, {
            anchor: churnDetector.anchorRef(taskId), head, baseline: state.churnAccepted?.counts || {},
        });

        if (escalated) {
            const by = await churnAcceptedBy(ticket.id);
            if (by) {
                Object.assign(state, { status: 'in_progress', churnAccepted: { at: now(), by, counts: result.counts }, updated_at: now() });
                writeTaskState(dir, state);
                console.log(`[churn] Task ${taskId}: churn aceito por ${by} — despachando o implement.`);
                return { proceed: true, accepted: by };
            }
            if (!state.churnEscalationNotifiedAt && state.churnReport
                && await postRedmineNote(ticket.id, formatChurnComment(ticket, taskId, state.churnReport, threshold))) {
                state.churnEscalationNotifiedAt = now();
                writeTaskState(dir, state);
            }
            return { proceed: false, reason: 'churn_escalation', report: state.churnReport };
        }

        if (!result.churnDetected) {
            console.log(`[churn] Task ${taskId}: ${result.commitsAnalyzed} rodada(s) analisada(s), nenhum arquivo em churn (limite ${threshold}).`);
            return { proceed: true };
        }

        const report = { detectedAt: now(), threshold, files: result.files };
        state.events = Array.isArray(state.events) ? state.events : [];
        state.events.push({ type: 'churn_escalation', node: 'implement', at: report.detectedAt,
            detail: result.files.map(f => `${f.path} ×${f.modificationCount}`).join(', ') });
        Object.assign(state, { status: 'churn-escalation', churnReport: report, updated_at: now() });
        delete state.churnEscalationNotifiedAt;
        if (await postRedmineNote(ticket.id, formatChurnComment(ticket, taskId, report, threshold))) {
            state.churnEscalationNotifiedAt = now();
        }
        writeTaskState(dir, state);
        console.warn(`[churn] Task ${taskId}: churn detectado (${result.files.map(f => `${f.path} ×${f.modificationCount}`).join(', ')}) — churn-escalation, relatório no Redmine.`);
        return { proceed: false, reason: 'churn_escalation', report };
    } catch (e) {
        console.error(`[churn] Task ${taskId}: falha na detecção de churn (sigo sem o portão):`, e.message);
        return { proceed: !escalated, reason: escalated ? 'churn_escalation' : undefined };
    }
}

// ---------------------------------------------------------------------------------
// Despacho de segmentos. Um segmento = uma invocação de agente. O watcher decide só
// QUAL segmento despachar agora; quem decide o próximo (inclusive se o resultado foi
// aprovado/reprovado) é o próprio comando rodando dentro do segmento, que deixa isso
// escrito em state.json pro próximo tick continuar.

function logPathFor(ticketId) {
    fs.mkdirSync(RUNS_DIR, { recursive: true });
    return `${RUNS_DIR}/${ticketId}.log`;
}

// Linha [watcher] no mesmo arquivo por onde passa a saída [claude] do agente (ver
// spawnAgent/spawnAgentDetached) — dá ao dashboard (GET /api/runs/:taskId/log) um
// fio de eventos do próprio ciclo (início de nó, status final) intercalado com a
// saída do agente. Sem redação: mensagens internas do watcher são texto fixo, não
// carregam segredo por construção (mesma premissa de scripts/sanitize-log.js sobre
// não sanitizar o que não vem de processo filho).
function logRun(ticketId, prefix, line) {
    try {
        fs.appendFileSync(logPathFor(ticketId), `${new Date().toISOString()} ${prefix} ${line}\n`);
    } catch (e) {
        console.warn(`[log] falha gravando linha [watcher] pro ticket #${ticketId}: ${e.message}`);
    }
}

function sessionNameFor(ticketId, isRecusaQA, label) {
    return `Ticket #${ticketId}${isRecusaQA ? ' (retrabalho)' : ''} — ${label}`;
}

// Ambiente limpo pro agente filho: remove qualquer variável de IDENTIDADE DE SESSÃO
// Claude Code (CLAUDE_CODE_SESSION_ID, CLAUDE_CODE_CHILD_SESSION, etc.) herdada do
// processo pai. Isso importa sempre que o watcher roda dentro de OUTRA sessão Claude
// Code viva (ex: disparado por uma sessão de teste/manutenção, como aconteceu
// validando esta evolução) — sem isso, o `claude -p` filho herda
// CLAUDE_CODE_CHILD_SESSION=1 do pai e passa a resolver caminhos relativos
// (memory/runs/...) contra o projeto REGISTRADO do pai (o checkout principal) em vez
// do seu próprio cwd (o worktree do ticket) — bug real observado disparando o
// ticket #43425 de dentro desta própria sessão: os arquivos foram escritos de
// verdade, só que no checkout principal, não no worktree. Um watcher disparado por
// cron/terminal comum (uso normal em produção) não teria essas variáveis pra
// começo de conversa, mas remover explicitamente é defesa em profundidade — nunca
// custa, e protege contra qualquer forma de aninhamento futuro.
// app-back exige JDK 25 (maven.compiler.release=25 no pom.xml), mas o JAVA_HOME
// padrão desta máquina aponta pro JDK 17 (usado por outros projetos) — sem isso, todo
// `mvnw compile`/`test` que os agentes tentam rodar falha com "release version 25 not
// supported", mascarando resultado real de build atrás de um problema de ambiente
// (visto 2x ao vivo: implement do ticket #43425, nas duas rodadas). Só sobrescreve
// pro PROCESSO FILHO — não mexe no JAVA_HOME/perfil de shell do usuário, que pode
// ter outros projetos em JDK diferente.
const JDK25_HOME = process.env.WATCHER_JAVA_HOME;

function cleanAgentEnv() {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
        if (key.startsWith('CLAUDE') || key === 'AI_AGENT') delete env[key];
    }
    withClaudeAccount(env);
    env.PRISMA_ROOT = PRISMA_ROOT;
    env.REPO_PATH = REPO_PATH;
    env.WATCHER_MAIN_REPO_NAME = process.env.WATCHER_MAIN_REPO_NAME || path.basename(REPO_PATH);
    if (JDK25_HOME && fs.existsSync(JDK25_HOME)) {
        env.JAVA_HOME = JDK25_HOME;
        env.PATH = `${JDK25_HOME}/bin:${env.PATH}`;
    }
    return env;
}

// Frases que indicam que o CLAUDE (não a tarefa) está indisponível agora — limite
// de conta/uso, erro de autenticação — e não um erro de conteúdo. Detectado só em
// modo --follow (o único em que dá pra inspecionar a saída antes do processo sair;
// modo normal é fire-and-forget por design, detecção fica pro próximo tick perceber
// que state.json não avançou). Encontrado ao vivo validando o orquestrador: Claude
// bateu "session limit" no meio do teste com o ticket #43425 — motivo real da
// lista, não hipotético. Sem um segundo agente pra assumir no mesmo tick (ver
// memory/decisions/2026-09-18-remocao-codex-workflow.md), a única ação possível
// aqui é logar e deixar o próximo tick tentar de novo.
// `\b429\b` isolado foi removido depois de um falso positivo real: bateu com
// "14:19:15,429" (milissegundos de timestamp) num log de build do Quarkus durante o
// /test do ticket #43425. Todo padrão aqui precisa de contexto textual específico o
// bastante pra não colidir com números soltos em log de build/teste normal.
const UNAVAILABLE_SIGNATURES = [
    /session limit/i, /usage limit/i, /rate limit exceeded/i, /quota exceeded/i,
    /401 unauthorized/i, /missing bearer/i, /429 too many requests/i,
];
function looksUnavailable(output) {
    return UNAVAILABLE_SIGNATURES.some(re => re.test(output));
}

// Estouro de janela de contexto/tokens da PRÓPRIA sessão (não indisponibilidade do
// provedor) — diferente de UNAVAILABLE_SIGNATURES acima: ali a ação é "deixa o
// próximo tick tentar de novo sozinho"; aqui o run precisa ficar visível e travado
// (status="session_limit") até uma retomada manual pelo dashboard (POST
// /api/runs/:taskId/resume-session), porque simplesmente redespachar do zero
// perderia o que a sessão anterior tinha acumulado. "session limit" aparece nas
// duas listas de propósito — texto igual, ação diferente — por isso a checagem
// desta lista tem precedência (ver dispatchTicket, comentário "estouro de
// contexto/tokens" perto do looksUnavailable(output) existente).
const SESSION_LIMIT_SIGNATURES = [
    /context window/i, /max_tokens/i, /token limit/i, /session limit/i,
];
function looksLikeSessionLimit(stderrText) {
    return SESSION_LIMIT_SIGNATURES.some(re => re.test(stderrText));
}

// Spawna o processo `claude` do jeito certo pro modo --follow ou não — mesma
// lógica de robustez do watcher original: sem --follow, o pai sai logo, então
// stdio precisa ser um fd de arquivo de verdade (sobrevive ao pai morrer); com
// --follow, pipe normal via Node é seguro porque o pai fica vivo até o filho sair.
// Retorna {code, output} — output só é populado em modo --follow (o único em que dá
// pra capturar antes do processo sair); serve pra looksUnavailable() logar o motivo
// real sem esperar o próximo tick.
// lease (opcional, ver nodeLease): liberado quando o agente sai — em --follow aqui
// mesmo, no exit; sem --follow, por um wrapper sh que roda o `claude` e em seguida
// `node lib/node-lease.js release`, já que o watcher não fica vivo pra ver o exit.
// Se nada disso rodar (watcher/máquina morreu), sobra status "running" e quem trata
// é a recuperação de órfão no próximo startup (recoverOrphanedNodes).
// code: exit code do agente (null = sinal/falha no spawn) — vira os eventos de saída
// do nó em state.json.events (nodeEvents.recordNodeExit; falha lá só é logada).
function releaseLease(lease, code) {
    if (!lease) return;
    try {
        if (lease.dir) {
            nodeLease.releaseNode(lease);
            nodeEvents.recordNodeExit(lease, code);
        } else if (lease.runsDir) {
            const dir = nodeLease.stampNewTask(lease.runsDir, lease.prefix, lease);
            nodeLease.clearFetchDispatch(lease.gatePath, lease.startedAt);
            if (dir) nodeEvents.recordNodeExit(lease, code, dir);
        }
    } catch (e) {
        console.error('[recovery] falha liberando lease do nó:', e.message);
    }
}

function spawnAgent(bin, args, cwd, logPath, lease = null, extraEnv = {}) {
    const env = { ...cleanAgentEnv(), ...extraEnv };
    // Dono da execução (scripts/cas.js): a CLI scripts/state-writer.js usa como execution_id
    // esperado nas transições do agente — sessão assumida por outra (resume/replay) é recusada.
    if (lease?.executionId) env.STATE_EXECUTION_ID = lease.executionId;
    if (FOLLOW) {
        const logFile = fs.createWriteStream(logPath, { flags: 'a' });
        // stdin='ignore': evita que o processo fique esperando um EOF que nunca
        // chega. `claude -p` é tolerante (timeout de 3s e segue em frente), mas
        // ignorar stdin não tem custo nenhum já que nunca escrevemos nele.
        const child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
        nodeLease.recordAgentPid(lease, child.pid);
        // SIGTERM no watcher repassa pro agente (GracefulShutdown) — sem isto ele ficaria solto.
        if (watcherState.activeCycle) watcherState.activeCycle.child = child;
        // Toda saída do agente passa pela redação de secrets antes de chegar no log,
        // no terminal ou em `output`.
        const stdout = child.stdout.pipe(sanitizeLog.createSanitizingStream(sanitizeAgentOutput));
        const stderr = child.stderr.pipe(sanitizeLog.createSanitizingStream(sanitizeAgentOutput));
        let output = '';
        let stderrBuffer = '';
        stdout.on('data', d => { output += d; });
        stderr.on('data', d => { output += d; stderrBuffer += d; });
        // end:false — os dois fluxos escrevem no mesmo arquivo; o primeiro a terminar
        // não pode fechá-lo enquanto o outro ainda despeja o que tinha retido. O
        // prefixo [claude] (scripts/sanitize-log.js) só vai pro arquivo — output/
        // stderrBuffer (usados por looksUnavailable/looksLikeSessionLimit) continuam
        // exatamente como antes, sem prefixo.
        const stdoutForFile = stdout.pipe(sanitizeLog.createLinePrefixStream('[claude]'));
        const stderrForFile = stderr.pipe(sanitizeLog.createLinePrefixStream('[claude]'));
        stdoutForFile.pipe(logFile, { end: false });
        stderrForFile.pipe(logFile, { end: false });
        stdout.pipe(process.stdout);
        stderr.pipe(process.stderr);
        // Espera o fim dos streams QUE ESCREVEM NO ARQUIVO (não stdout/stderr direto):
        // com o prefixo no meio do pipe, 'end' em stdout/stderr não garante mais que a
        // última linha já foi escrita em logFile — só o 'end' do stream final garante.
        const drained = Promise.all([stdoutForFile, stderrForFile].map(s => new Promise(r => { s.on('end', r); s.on('error', r); })))
            .then(() => logFile.end());
        return new Promise(resolve => {
            child.on('exit', code => { releaseLease(lease, code); drained.then(() => resolve({ code, output, stderr: stderrBuffer })); });
            child.on('error', () => { releaseLease(lease, null); resolve({ code: null, output, stderr: stderrBuffer }); });
        });
    }
    const logFd = fs.openSync(logPath, 'a');
    const [cmd, cmdArgs] = lease
        ? ['/bin/sh', ['-c', `n=$1; l=$2; a=$3; shift 3; ${bin} "$@"; c=$?; "$n" "$l" release "$a" "$c"; exit $c`,
            'sh', process.execPath, NODE_LEASE_SCRIPT, JSON.stringify(lease), ...args]]
        : [bin, args];
    // O agente sobrevive ao watcher, então a redação de secrets roda num processo
    // próprio (sanitize-log.js como filtro, também detached) entre o agente e o log:
    // o agente escreve no stdin do filtro, o filtro escreve no arquivo. O watcher
    // fecha a sua ponta do pipe logo após o spawn, e o filtro sai sozinho no EOF
    // (quando o agente — e o release do lease, no wrapper sh — terminam).
    const filter = spawn(process.execPath, [SANITIZE_LOG_SCRIPT], { env, detached: true, stdio: ['pipe', logFd, logFd] });
    filter.unref();
    const child = spawn(cmd, cmdArgs, { cwd, env, detached: true, stdio: ['ignore', filter.stdin, filter.stdin] });
    nodeLease.recordAgentPid(lease, child.pid);
    filter.stdin.destroy();
    fs.closeSync(logFd);
    child.unref();
    // pid só serve pro rastreamento de custo saber, num tick futuro, se este
    // processo já terminou (ver finalizePendingCostRuns).
    return Promise.resolve({ code: null, output: '', stderr: '', pid: child.pid });
}

// ---------------------------------------------------------------------------------
// Rastreamento de custo por nó (state.json.cost_tracking — ver
// .graph/schemas/state.schema.json e scripts/lib/cost-tracking.js). Efeito colateral
// puro do despacho: nada aqui decide o que despachar, e toda chamada é protegida por
// try/catch — falha medindo custo nunca pode derrubar/alterar o fluxo do grafo.
//
// Fontes:
//   - duration_ms: relógio do watcher, a partir de logo antes do spawn. Com --follow o
//     fim é o exit do processo. Sem --follow o watcher sai antes do agente terminar,
//     então o fechamento acontece num tick seguinte (quando o pid já morreu) e o fim é
//     o último timestamp do transcript da sessão (fallback: mtime do transcript; em
//     último caso, o momento em que o watcher notou o processo morto).
//   - tokens do Claude: `claude -p` em modo texto (o que vai pro .log) não expõe usage
//     na saída — então o watcher fixa --session-id no despacho e soma message.usage do
//     transcript JSONL dessa sessão (+ subagentes) em ~/.claude/projects/.
//   - tokens do Codex: seção "## Tokens" de codex-result-<node>.md (ver AGENTS.md).
//     Hoje o watcher só despacha Claude; o caminho fica pronto pra um despacho Codex.
//
// O run pendente vive em ${RUNS_DIR}/<ticket>-cost.json, fora do state.json: no
// despacho fetch_ticket+plan a task dir ainda não existe, e o agente reescreve
// state.json durante o nó. O mesmo arquivo guarda a cópia autoritativa do
// cost_tracking de cada task, reaplicada no state.json a cada fechamento — um agente
// que regrave state.json sem o campo não perde o acumulado.

// O transcript fica no CLAUDE_CONFIG_DIR da conta que rodou o agente (seletor "Conta do
// Claude" do dashboard / WATCHER_CLAUDE_CONFIG_DIR — ver lib/claude-account.js), não
// sempre em ~/.claude: com ~/.claude-personal selecionada o custo saía null. O despacho
// grava a conta no run pendente; a busca tenta ela, depois a conta atual, a padrão e as
// demais instaladas (run antigo sem o campo, ou conta trocada no meio do nó).
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

function claudeProjectsDirsFor(run) {
    const dirs = [
        run?.claude_config_dir ? path.join(run.claude_config_dir, 'projects') : null,
        (() => { const { dir } = resolveClaudeAccount(); return dir ? path.join(dir, 'projects') : null; })(),
        CLAUDE_PROJECTS_DIR,
        ...listClaudeAccounts().map(a => path.join(a.dir, 'projects')),
    ].filter(Boolean);
    return [...new Set(dirs)];
}

function findRunTranscripts(run) {
    for (const dir of claudeProjectsDirsFor(run)) {
        const files = costTracking.findClaudeTranscripts(run.session_id, dir);
        if (files.length) return files;
    }
    return [];
}
// pid reaproveitado pelo SO faria um run parecer vivo pra sempre — acima disto, trata
// como terminado mesmo com o pid respondendo.
const MAX_COST_RUN_MS = 12 * 60 * 60 * 1000;

function costLedgerPath(ticketId) {
    return `${RUNS_DIR}/${ticketId}-cost.json`;
}

function readCostLedger(ticketId) {
    const p = costLedgerPath(ticketId);
    let ledger = {};
    if (fs.existsSync(p)) {
        try { ledger = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { ledger = {}; }
    }
    return { ticket_id: ticketId, pending: [], tasks: {}, unattributed: [], ...ledger };
}

function writeCostLedger(ticketId, ledger) {
    fs.mkdirSync(RUNS_DIR, { recursive: true });
    fs.writeFileSync(costLedgerPath(ticketId), JSON.stringify(ledger, null, 2));
}

function startCostRun(ticketId, { agent, nodes, sessionId }) {
    if (DRY_RUN) return null;
    try {
        const account = agent === 'claude' ? resolveClaudeAccount().dir : null;
        const run = { session_id: sessionId, agent, nodes, started_at_ms: Date.now(), pid: null, ...(account ? { claude_config_dir: account } : {}) };
        const ledger = readCostLedger(ticketId);
        ledger.pending.push(run);
        writeCostLedger(ticketId, ledger);
        return run;
    } catch (e) {
        console.error(`[custo] #${ticketId}: falha registrando início do despacho (seguindo sem métrica):`, e.message);
        return null;
    }
}

function setCostRunPid(ticketId, sessionId, pid) {
    try {
        const ledger = readCostLedger(ticketId);
        const run = ledger.pending.find(r => r.session_id === sessionId);
        if (!run) return;
        run.pid = pid ?? null;
        writeCostLedger(ticketId, ledger);
    } catch (e) {
        console.error(`[custo] #${ticketId}: falha registrando pid do despacho:`, e.message);
    }
}

function pidAlive(pid) {
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return e.code === 'EPERM';
    }
}

// Task que recebe o custo: a ativa. Só o run do /commit cai na arquivada mais recente
// (o próprio /commit arquiva a task em memory/runs/_archive/ no segmento) — pra
// qualquer outro nó, cair no archive atribuiria o custo ao ciclo anterior do ticket
// (ex: fetch_ticket de uma Recusa QA que travou antes de criar a task nova).
function findCostTargetTask(ticketId, node) {
    const active = findActiveTask(ticketId);
    // Task corrompida: sem alvo (vai pra unattributed) — reescrever o state.json dela
    // com só cost_tracking apagaria o conteúdo que o humano precisa pra corrigir.
    if (active?.corrupted) return null;
    if (active || node !== 'commit') return active;
    const archiveDir = taskArchiveDir(ticketId);
    let best = null;
    for (const name of listTaskDirs(archiveDir, ticketId)) {
        const dir = `${archiveDir}/${name}`;
        const state = readStateJson(dir);
        if (!state) continue;
        const updated = new Date(state.updated_at || state.started_at || 0).getTime();
        if (!best || updated > best.updated) best = { taskId: name, dir, state, updated };
    }
    return best;
}

function collectRunMetrics(run, target, endMs) {
    const node = run.nodes[run.nodes.length - 1];
    let tokens = { input_tokens: null, output_tokens: null };
    let observedEnd = null;
    if (run.agent === 'claude') {
        const files = findRunTranscripts(run);
        const usage = costTracking.sumClaudeUsage(files.map(f => fs.readFileSync(f, 'utf8')));
        tokens = usage;
        observedEnd = usage.last_timestamp_ms
            ?? (files.length ? Math.max(...files.map(f => fs.statSync(f).mtimeMs)) : null);
    } else if (run.agent === 'codex' && target) {
        const resultPath = `${target.dir}/codex-result-${node}.md`;
        if (fs.existsSync(resultPath)) {
            tokens = costTracking.parseCodexResultTokens(fs.readFileSync(resultPath, 'utf8'));
            observedEnd = fs.statSync(resultPath).mtimeMs;
        }
    }
    const end = endMs ?? (observedEnd && observedEnd >= run.started_at_ms ? observedEnd : Date.now());
    const metrics = { duration_ms: end - run.started_at_ms };
    for (const field of costTracking.METRIC_FIELDS) metrics[field] = tokens[field] ?? null;
    if (tokens.models?.length) metrics.models = tokens.models;
    return { node, metrics };
}

// Fecha um run pendente: mede, acumula no cost_tracking da task e grava no state.json.
// Nunca toca state.updated_at — ele decide findActiveTask e o "já tratado neste ciclo"
// de mostRecentArchivedCommit; métrica não pode mexer nisso.
function finishCostRun(ticketId, sessionId, endMs = null, outcome = {}) {
    try {
        const ledger = readCostLedger(ticketId);
        const idx = ledger.pending.findIndex(r => r.session_id === sessionId);
        if (idx === -1) return;
        const run = ledger.pending[idx];
        const target = findCostTargetTask(ticketId, run.nodes[run.nodes.length - 1]);
        const { node, metrics } = collectRunMetrics(run, target, endMs);
        ledger.pending.splice(idx, 1);

        if (!target) {
            // Ex: fetch_ticket travou antes de criar task (pergunta pré-task). Guarda
            // em vez de descartar — foi custo real.
            ledger.unattributed.push({ ...run, node, ...metrics, finished_at: new Date().toISOString() });
            writeCostLedger(ticketId, ledger);
            captureTranscript(ticketId, run, null, node, metrics, outcome);
            return;
        }

        const state = readStateJson(target.dir) || {};
        const current = ledger.tasks[target.taskId] || state.cost_tracking || costTracking.emptyCostTracking();
        const updated = costTracking.mergeRun(current, {
            node, agent: run.agent, alsoCovers: run.nodes.slice(0, -1), metrics,
        });
        ledger.tasks[target.taskId] = updated;
        writeCostLedger(ticketId, ledger);
        // Métrica é campo secundário: grava sobre o disco fresco, sem state_version novo.
        stateWriter.update(target.dir, s => { s.cost_tracking = updated; }, { operation: 'cost_tracking', actor: 'watcher' });
        checkWrittenState(target.dir);
        console.log(`[custo] ${target.taskId} nó ${node}: ${metrics.duration_ms}ms, ` +
            `in=${metrics.input_tokens ?? 'null'} out=${metrics.output_tokens ?? 'null'} (loop_count=${updated.totals.loop_count})`);
        captureTranscript(ticketId, run, target, node, metrics, outcome);
    } catch (e) {
        console.error(`[custo] #${ticketId}: falha fechando métrica do despacho ${sessionId}:`, e.message);
    }
}

// ---------------------------------------------------------------------------------
// Transcrição por nó pra post-mortem (scripts/lib/transcript-writer.js). Roda no mesmo
// ponto que fecha o custo — uma vez por despacho, no exit (--follow) ou no tick em que o
// pid morreu — e reaproveita a task-alvo e as métricas já medidas. Efeito colateral
// puro: qualquer exceção é logada e o ciclo segue. Conteúdo fica só em disco local.
//
// Status: 'failed' se o exit code conhecido != 0, se o transcript tem erro de API, ou
// se state.events tem node_error/escalation deste nó desde o despacho; 'success' exige
// evidência de saída limpa (exit 0 ou node_end). Sem evidência nenhuma (watcher caiu,
// run velho demais) => 'failed', pra ficar retido pela política de retenção.
function transcriptStatus(run, node, state, outcome, apiError) {
    if (apiError) return 'failed';
    const since = run.started_at_ms;
    const events = (Array.isArray(state?.events) ? state.events : []).filter(e => {
        const t = Date.parse(e.ts || e.at);
        return e.node === node && Number.isFinite(t) && t >= since - 1000;
    });
    if (events.some(e => e.type === 'node_error' || e.type === 'escalation')) return 'failed';
    if (outcome.exitCode !== undefined) return outcome.exitCode === 0 ? 'success' : 'failed';
    return events.some(e => e.type === 'node_end') ? 'success' : 'failed';
}

function collectConversation(run, target, node) {
    if (run.agent === 'claude') {
        const files = findRunTranscripts(run).map(f => ({
            content: fs.readFileSync(f, 'utf8'),
            source: f.includes(`${path.sep}subagents${path.sep}`) ? `subagent:${path.basename(f, '.jsonl')}` : 'main',
        }));
        const converted = transcriptWriter.conversationFromClaudeJsonl(files);
        return { ...converted, sourceFiles: files.length };
    }
    const resultPath = target ? `${target.dir}/codex-result-${node}.md` : null;
    if (resultPath && fs.existsSync(resultPath)) {
        const st = fs.statSync(resultPath);
        return {
            conversation: [{ role: 'assistant', content: fs.readFileSync(resultPath, 'utf8'), timestamp: st.mtime.toISOString(), source: 'codex-result' }],
            skippedLines: 0, apiError: false, sourceFiles: 1,
        };
    }
    return { conversation: [], skippedLines: 0, apiError: false, sourceFiles: 0 };
}

function captureTranscript(ticketId, run, target, node, metrics, outcome = {}) {
    if (DRY_RUN || process.env.TRANSCRIPTS_DISABLED === 'true') return null;
    const label = target ? target.taskId : `#${ticketId}`;
    try {
        // Sem task (fetch_ticket travou antes de criá-la): guarda à parte, fora do scan
        // de runs (prefixo _), em vez de perder justamente a transcrição da falha.
        const taskId = target ? target.taskId : `unattributed-${ticketId}`;
        const taskDir = target ? target.dir : `${RUNS_DIR}/_transcripts-unattributed/${ticketId}`;
        const { conversation, skippedLines, apiError, sourceFiles } = collectConversation(run, target, node);
        const status = transcriptStatus(run, node, target ? readStateJson(target.dir) : null, outcome, apiError);
        // Saída do processo (só existe em --follow) ajuda quando o agente morreu antes
        // de gravar qualquer coisa no transcript.
        if (status === 'failed' && outcome.output) {
            conversation.push({ role: 'system', content: `[saída do processo]\n${String(outcome.output).slice(-8000)}`, timestamp: new Date().toISOString(), source: 'watcher' });
        }
        const finishedMs = run.started_at_ms + (metrics.duration_ms || 0);
        const tokenUsage = {};
        for (const f of costTracking.METRIC_FIELDS) tokenUsage[f] = metrics[f] ?? null;
        const metadata = {
            model: metrics.models?.[0] ?? null,
            models: metrics.models || [],
            startedAt: new Date(run.started_at_ms).toISOString(),
            finishedAt: new Date(finishedMs).toISOString(),
            tokenUsage,
            status,
            agent: run.agent,
            sessionId: run.session_id,
            alsoCovers: run.nodes.slice(0, -1),
            exitCode: outcome.exitCode ?? null,
            partial: sourceFiles === 0 || skippedLines > 0,
            skippedLines,
        };
        // Síncrono: o mesmo tick pode despachar o próximo nó logo depois (ver
        // writeTranscriptSync).
        const entry = transcriptWriter.writeTranscriptSync(taskId, node, null, conversation, metadata, { taskDir, sanitize: sanitizeAgentOutput });
        if (target) checkWrittenState(target.dir);
        console.log(`[transcript] ${label} nó ${node} tentativa ${entry.attempt}: ${entry.path} (${entry.sizeBytes} bytes, ${status})`);
        return entry;
    } catch (e) {
        console.error(`[transcript] ${label} nó ${node}: falha gravando transcrição (ciclo segue):`, e.message);
        return null;
    }
}

// Sem --follow: fecha os runs cujo processo já saiu. Roda no começo de cada tick, pra
// todos os tickets com run pendente — inclusive os que não serão mais despachados
// (ex: acabou de rodar /commit, sai da lista do Redmine e da task ativa local).
// Com --ticket, só o ticket do filtro: fechar o custo grava state.json, *-cost.json e
// transcripts/ da task, e o tick controlado não pode tocar em tasks de outro ticket.
function finalizePendingCostRuns() {
    if (DRY_RUN || SIMULATE || !fs.existsSync(RUNS_DIR)) return;
    for (const f of fs.readdirSync(RUNS_DIR)) {
        const m = f.match(/^(\d+)-cost\.json$/);
        if (!m) continue;
        const ticketId = Number(m[1]);
        if (ONLY_TICKET && ticketId !== ONLY_TICKET) continue;
        try {
            for (const run of readCostLedger(ticketId).pending) {
                const tooOld = Date.now() - run.started_at_ms > MAX_COST_RUN_MS;
                // pid null = watcher caiu entre o spawn e registrar o pid: sem como
                // saber, espera o limite de idade.
                const running = run.pid ? pidAlive(run.pid) : true;
                if (!running || tooOld) finishCostRun(ticketId, run.session_id);
            }
        } catch (e) {
            console.error(`[custo] #${ticketId}: falha revisando runs pendentes:`, e.message);
        }
    }
}

function siblingAddDirArgs(ticketId) {
    const args = [];
    for (const repo of SIBLING_REPOS) {
        const repoPath = `${WORKSPACE}/${repo}`;
        const wt = worktreePathFor(repoPath, ticketId);
        if (fs.existsSync(wt)) args.push('--add-dir', wt);

        // Convenção legada: worktree do repo irmão aninhado dentro do PRÓPRIO
        // app-back (REPO_PATH/.claude/worktrees/<ticket>-<repo>), em vez de
        // <repo>/.claude/worktrees/<ticket> (a convenção atual, acima). Achado ao
        // vivo no ticket #42359: o WIP real de retrabalho (branch
        // fix/42359-recusas-qa) só existia aqui — o caminho padrão apontava pra uma
        // branch obsoleta (`42359`, 1652 commits defasada de origin/development).
        // Implement ficou "blocked" com acesso de leitura à raiz errada e nenhum
        // acesso à raiz certa. Inclui as duas se ambas existirem (não são
        // conflitantes — são worktrees em branches diferentes do mesmo repo); cabe
        // ao agente decidir qual usar, com base no que handoff.md/context.md
        // registrar sobre qual branch é a válida.
        const legacyWt = `${REPO_PATH}/.claude/worktrees/${ticketId}-${repo}`;
        if (legacyWt !== wt && fs.existsSync(legacyWt)) args.push('--add-dir', legacyWt);
    }
    return args;
}

// Contexto pré-montado (scripts/lib/prompt-context.js) pros nós plan e review: descrição
// do ticket e context.md truncados, nomes de arquivos (plan) ou o diff real + pré-checagens
// de secret/lint (review). Sanitizado — vai pro argv do `claude -p`. Falha aqui nunca
// bloqueia o despacho: o nó roda sem o bloco, como antes (os comandos sabem ler sozinhos).
function dom06AttemptEnv(decision) {
    if (!decision?.attemptFile) return {};
    return {
        DOM06_ATTEMPT_FILE: decision.attemptFile,
        DOM06_AUTHORIZE_BIN: path.join(__dirname, 'lib', 'dom06-attempt.js'),
    };
}

function dom06SpecHash(state, worktreePath, ticketId) {
    if (state?.spec?.hash) return state.spec.hash;
    if (state?.spec_hash) return state.spec_hash;
    const specFile = path.join(worktreePath, 'memory', 'spec', `${ticketId}-spec.md`);
    if (!fs.existsSync(specFile)) return null;
    return crypto.createHash('sha256').update(fs.readFileSync(specFile)).digest('hex');
}

function recordDom06NodeEffect(attemptFile, attemptId, code) {
    if (!attemptFile || code !== 0) return;
    try {
        dom06.recordEffect(attemptFile, {
            obligation_id: 'execute_node',
            idempotency_key: `execute:${attemptId}`,
            status: 'fulfilled',
        });
    } catch (e) {
        console.error(`Falha registrando effect do Attempt ${attemptId}:`, e.message);
    }
}

function repoWorktrees(ticketId, worktreePath) {
    const repos = [{ name: process.env.WATCHER_MAIN_REPO_NAME || path.basename(REPO_PATH), path: worktreePath }];
    for (const repo of SIBLING_REPOS) {
        const wt = worktreePathFor(`${WORKSPACE}/${repo}`, ticketId);
        if (fs.existsSync(wt)) repos.push({ name: repo, path: wt });
    }
    return repos;
}

function nodeContextBlock(node, { ticket, dir = null, worktreePath }) {
    try {
        const contextMd = dir && fs.existsSync(`${dir}/context.md`) ? fs.readFileSync(`${dir}/context.md`, 'utf8') : '';
        const repos = repoWorktrees(ticket.id, worktreePath);
        if (node === 'plan') return promptContext.planContextBlock({ ticket, contextMd, repos, sanitize: sanitizeAgentOutput });
        if (node === 'review') {
            const contractPath = dir ? `${dir}/openapi-contract.yaml` : null;
            return promptContext.reviewContextBlock({ repos, contextMd, contractPath, sanitize: sanitizeAgentOutput });
        }
    } catch (e) {
        console.error(`#${ticket.id}: falha montando contexto pré-montado do nó ${node} (segue sem ele):`, e.message);
    }
    return '';
}

// Nós que nunca abrem subagente: no plan, um Explore em Opus custou 2,5× a sessão
// inteira (#43590) lendo arquivos Java completos. O review ainda pode chamar o
// subagente de domínio (security-reviewer/schema-guardian) — ver review.md.
const NO_SUBAGENT_NODES = new Set(['plan']);

// Segmento Claude: encadeia comandos de barra dentro de UMA sessão `claude -p`.
// Só existem dois pontos de entrada usados hoje: fetch_ticket(+plan) para task nova,
// e um único comando (`/plan`, `/review` ou `/verify`) pra resumir uma task ativa —
// nunca encadeia através de um nó com veredito (review/test/verify), porque o
// resultado desses só se sabe depois de rodar.
async function dispatchClaudeSegment({ ticket, isRecusaQA, qaFeedback, worktreePath, commands, nodes, extraNote, contextBlock = '', lease = null, extraEnv = {} }) {
    const qaSection = isRecusaQA
        ? `\n\nEste ticket voltou como Recusa QA — é retrabalho, não trabalho novo. ` +
          `Motivo(s) da recusa (comentários do QA, mais recente primeiro):\n${qaFeedback.join('\n')}\n` +
          `Trate isso como o critério de aceite principal do /plan.`
        : '';

    const prompt =
        `Você foi despachado pelo orquestrador (scripts/readmine-watcher.js) pra este ` +
        `ticket #${ticket.id} (tipo: ${ticket.tracker?.name || '?'}). Rode, nesta ordem: ` +
        `${commands.join(', ')}. ${extraNote} ` +
        `Leia cada template correspondente em ${PRISMA_ROOT}/.claude/commands/ e siga-o ` +
        `como instrução do nó; use ${PRISMA_ROOT}/scripts para os executáveis da plataforma. ` +
        `PRISMA_ROOT aponta para esses assets; o cwd/worktree continua sendo o consumidor. ` +
        `Pare assim que terminar o último comando listado — o próximo nó do grafo é ` +
        `despachado pelo orquestrador num próximo tick. Não avance sozinho além do ` +
        `que foi pedido aqui.` +
        (lease?.dir
            ? ` O orquestrador gravou status="running", node_started_at e node_timeout_ms no ` +
              `state.json antes deste despacho: preserve node_started_at/node_timeout_ms e só troque ` +
              `status se o comando mandar (blocked/escalated/committed/spec-invalid) — ao você sair, ` +
              `o orquestrador devolve "running" pra "in_progress" sozinho.`
            : '') +
        qaSection +
        contextBlock;

    const sessionName = sessionNameFor(ticket.id, isRecusaQA, commands[commands.length - 1]);
    const logPath = logPathFor(ticket.id);
    // Id de sessão fixado pelo watcher só pra achar o transcript depois (custo por nó).
    const sessionId = crypto.randomUUID();
    const args = [
        '-p', prompt,
        '--name', sessionName,
        '--session-id', sessionId,
        '--permission-mode', 'acceptEdits',
        '--allowedTools', 'mcp__redmine__*,Read,Edit,Write,Bash,Grep,Glob',
        ...(nodes.some(n => NO_SUBAGENT_NODES.has(n)) ? ['--disallowedTools', 'Agent,Task'] : []),
        // Sem isto, Claude ficava confinado ao cwd (worktree do consumidor) e não
        // enxergava os worktrees irmãos mesmo com branch/worktree já criados pelo
        // watcher, apesar da instrução em plan.md/commit.md dizer pra tratá-los
        // simetricamente (ver decision 2026-09-02-push-pr-siblings.md — corrigiu a
        // instrução, não este despacho).
        '--add-dir', PRISMA_ROOT,
        ...siblingAddDirArgs(ticket.id),
    ];
    if (SIMULATE) return simulateClaudeSegment({ ticket, nodes, lease, extraNote });
    console.log(`Despachando Claude (${commands.join(', ')}) para #${ticket.id} em ${worktreePath}`);
    const costRun = startCostRun(ticket.id, { agent: 'claude', nodes, sessionId });
    const result = await spawnAgent('claude', args, worktreePath, logPath, lease, extraEnv);
    if (costRun) {
        if (FOLLOW) finishCostRun(ticket.id, sessionId, Date.now(), { exitCode: result.code, output: result.stderr });
        else setCostRunPid(ticket.id, sessionId, result.pid);
    }
    return result;
}

// DRY-RUN: no lugar do `claude -p`, o agente simulado (lib/dry-run.js) escreve o que o
// comando escreveria; depois o lease é liberado como no exit do agente real (status
// volta pra in_progress, eventos node_end/node_retry/escalation). Sem custo por nó:
// não há transcript. As linhas vão também pro log do ticket (agent-log do dashboard).
async function simulateClaudeSegment({ ticket, nodes, lease, extraNote }) {
    const log = line => { console.log(line); logRun(ticket.id, '[claude]', line); };
    let result;
    try {
        result = await dryRun.simulateSegment({
            ticket, nodes, lease, extraNote, log,
            runsDir: taskRunsDir(ticket.id),
            baseBranch: BASE_BY_LIBERACAO[branchLiberacao(ticket)],
        });
    } catch (e) {
        console.error(`[dry-run] agente simulado falhou no(s) nó(s) ${nodes.join('+')}:`, e.message);
        result = { code: 1, output: e.message, stderr: e.message, simulated: true };
    }
    releaseLease(lease, result.code);
    try {
        result.finalize?.();
    } catch (e) {
        console.error('[dry-run] falha finalizando o nó simulado:', e.message);
    }
    return result;
}

// ---------------------------------------------------------------------------------
// Escopo de teste por microsserviço (scripts/lib/service-detector.js): o nó `test` roda
// só `mvn test -pl <módulos tocados>` em vez da suíte inteira. changedFiles = tudo que
// o ticket mudou em relação à base — commits desde o merge-base com origin/<base> +
// working tree (o /implement não commita) + untracked. Qualquer falha de git devolve
// [] e o detector cai na suíte completa (retrocompatível, nunca reduz escopo às cegas).
const SCOPED_TEST_NODES = new Set(['test', 'verify', 'commit']);

function gitLines(cwd, args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .split('\n').map(l => l.trim()).filter(Boolean);
}

function findMergeBase(worktreePath, base) {
    for (const ref of [`origin/${base}`, base]) {
        try { return gitLines(worktreePath, ['merge-base', 'HEAD', ref])[0] || null; } catch { /* tenta o próximo */ }
    }
    return null;
}

function collectChangedFiles(worktreePath, base) {
    try {
        const mergeBase = findMergeBase(worktreePath, base);
        if (!mergeBase) return [];
        return [...new Set([
            ...gitLines(worktreePath, ['diff', '--name-only', mergeBase]),
            ...gitLines(worktreePath, ['ls-files', '--others', '--exclude-standard']),
        ])];
    } catch {
        return [];
    }
}

// Calcula e grava state.json.affectedServices ([] = suíte completa). Regravado a cada
// despacho de test/verify/commit: se o agente reescrever state.json sem o campo, o
// próximo despacho repõe — e o /commit arquiva a task já com ele.
function stampAffectedServices(ticketId, taskId, dir, worktreePath, base) {
    const changedFiles = collectChangedFiles(worktreePath, base);
    const scope = serviceDetector.analyzeChangedFiles(changedFiles);
    if (scope.fullSuite) {
        const why = scope.reason === 'arquivo_fora_de_servico'
            ? `arquivo(s) fora de backend/<svc>/: ${scope.fullSuiteTriggers.slice(0, 5).join(', ')}${scope.fullSuiteTriggers.length > 5 ? '…' : ''}`
            : scope.reason === 'sem_arquivos_alterados' ? 'nenhum arquivo alterado detectado no diff' : 'nenhum microsserviço tocado';
        console.log(`[test-scope] Task ${taskId}: suíte completa (${why}).`);
    } else {
        console.log(`[test-scope] Task ${taskId}: escopo reduzido para ${scope.services.length} serviço(s) — ${scope.services.join(', ')} (${changedFiles.length} arquivo(s) no diff).`);
    }
    try {
        const state = readTaskState(dir);
        writeTaskState(dir, { ...state, affectedServices: scope.services });
        checkWrittenState(dir);
    } catch (e) {
        console.error(`Task ${taskId}: falha gravando affectedServices no state.json:`, e.message);
    }
    return scope;
}

// Diff (unified) só dos arquivos que podem mexer em schema — tracked desde o
// merge-base + untracked lidos como "new file" (o /implement não commita nem dá add).
function collectSchemaDiff(worktreePath, base, changedFiles) {
    const candidates = changedFiles.filter(schemaWatcher.isCandidate);
    if (!candidates.length) return '';
    const mergeBase = findMergeBase(worktreePath, base);
    if (!mergeBase) return '';
    let diff = '';
    try {
        diff = execFileSync('git', ['diff', mergeBase, '--', ...candidates],
            { cwd: worktreePath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    } catch { /* segue só com os untracked */ }
    let untracked = [];
    try { untracked = gitLines(worktreePath, ['ls-files', '--others', '--exclude-standard', '--', ...candidates]); } catch { /* sem untracked */ }
    for (const f of untracked) {
        let content = '';
        try { content = fs.readFileSync(path.join(worktreePath, f), 'utf8'); } catch { continue; }
        const lines = content.replace(/\n$/, '').split('\n');
        diff += `\ndiff --git a/${f} b/${f}\nnew file mode 100644\n--- /dev/null\n+++ b/${f}\n@@ -0,0 +1,${lines.length} @@\n` +
            lines.map(l => `+${l}`).join('\n') + '\n';
    }
    return diff;
}

// Detecta mudança de schema no diff do ticket e mantém a checklist de migração no
// context.md da task (append na primeira detecção; regenera só se o que foi detectado
// mudar; remove se o diff deixar de tocar schema). Só alerta — nunca bloqueia o ciclo,
// e qualquer falha aqui é logada e engolida.
function stampSchemaChecklist(taskId, dir, worktreePath, base) {
    try {
        const changedFiles = collectChangedFiles(worktreePath, base);
        const result = schemaWatcher.detectSchemaChanges(changedFiles, collectSchemaDiff(worktreePath, base, changedFiles));
        const p = `${dir}/context.md`;
        const existing = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
        const updated = schemaWatcher.upsertContextChecklist(existing, result);
        if (updated !== existing) {
            fs.writeFileSync(p, updated);
            console.log(result.detected
                ? `[schema] Task ${taskId}: ${result.changes.length} mudança(s) de schema (risco ${result.riskLevel}) — checklist de migração gravada no context.md.`
                : `[schema] Task ${taskId}: diff não toca mais schema — checklist de migração removida do context.md.`);
        }
        // Sinal pro dashboard (badge ⚠ SCHEMA na lista). schema_risk_level ≠ risk_level
        // (esse é o risco do PR, gravado pelo /verify). Só regrava se mudou.
        if (!fs.existsSync(`${dir}/state.json`)) return result;
        const state = readTaskState(dir);
        const riskLevel = result.detected ? result.riskLevel : null;
        if (state.schema_changes_detected !== result.detected || (state.schema_risk_level ?? null) !== riskLevel) {
            writeTaskState(dir, { ...state, schema_changes_detected: result.detected, schema_risk_level: riskLevel });
            checkWrittenState(dir);
        }
        return result;
    } catch (e) {
        console.error(`Task ${taskId}: falha gerando checklist de migração (seguindo sem ela):`, e.message);
        return null;
    }
}

function schemaChecklistNote(result) {
    if (!result || !result.detected) return '';
    return ` MUDANÇA DE SCHEMA (risco ${result.riskLevel}): o orquestrador anexou ao context.md da task a seção ` +
        `"## ⚠️ Schema Migration Checklist" (entre ${schemaWatcher.CONTEXT_BEGIN} … e ${schemaWatcher.CONTEXT_END}). ` +
        'Leve-a em conta neste nó, preserve o bloco se reescrever o context.md e marque os itens que resolver; ' +
        'preserve também schema_changes_detected/schema_risk_level do state.json se reescrever o arquivo. ' +
        'É alerta, não bloqueio.';
}

function testScopeNote(node, services) {
    const preserve = ' Preserve o campo affectedServices do state.json (gravado pelo orquestrador) se reescrever o arquivo.';
    if (node !== 'test') return preserve;
    const cmd = serviceDetector.testCommandFor(services);
    if (!cmd) return ' ESCOPO DE TESTE: configure TEST_COMMAND no consumidor antes de executar testes.' +
        ' Não assuma um comando de build/teste.' + preserve;
    return services.length
        ? ` ESCOPO DE TESTE: AFFECTED_SERVICES=${services.join(',')} (também na variável de ambiente AFFECTED_SERVICES). ` +
          `O diff deste ticket só toca esses microsserviços — rode \`${cmd}\` em vez da suíte completa.` + preserve
        : ` ESCOPO DE TESTE: AFFECTED_SERVICES vazio — o diff toca arquivos fora de backend/<svc>/ (raiz/configuração) ` +
          `ou não foi possível determiná-lo; rode a suíte completa (\`${cmd}\`).` + preserve;
}

// ---------------------------------------------------------------------------------
// Decide e dispara o próximo segmento pra um ticket. Retorna um resumo curto pro log
// de observabilidade (nunca usado pra decidir o próximo tick — só pra o humano ler).

// state.json de uma task falhou na validação (JSON malformado ou fora do schema):
// marca status="state_corrupted" e escala pra humano — NUNCA redespacha nó nenhum em
// cima de um estado que não dá pra confiar. Escreve direto no arquivo, sem passar por
// writeTaskState/checkWrittenState (revalidar aqui só relogaria o mesmo erro).
// Idempotente: se o arquivo já está marcado, só (re)notifica (notifyBlocked já
// deduplica por assinatura). JSON malformado não tem objeto pra preservar — o
// conteúdo original vai pra state.json.corrupted-<ts> antes de ser substituído por um
// state mínimo marcado. Nunca lança: corrupção de UMA task não pode derrubar o tick.
async function handleCorruptedState(ticket, active) {
    const { taskId, dir, check } = active;
    const detail = check.errors.join('; ');
    console.error(`[state-error] Task ${taskId}: state.json inválido — ${detail}`);
    const raw = check.raw && typeof check.raw === 'object' && !Array.isArray(check.raw) ? check.raw : null;
    const node = raw && typeof raw.node === 'string' ? raw.node : 'desconhecido';
    const result = { action: 'skip', reason: 'state_corrupted', status: 'state_corrupted', taskId, node, errors: check.errors };
    if (DRY_RUN) return result;

    let marked = raw;
    try {
        if (!raw || raw.status !== 'state_corrupted') {
            const at = new Date().toISOString();
            const stateError = { detected_at: at, reason: check.reason, errors: check.errors };
            if (raw) {
                stateError.previous_status = raw.status;
                marked = { ...raw };
            } else {
                const backup = `${dir}/state.json.corrupted-${Date.now()}`;
                fs.copyFileSync(`${dir}/state.json`, backup);
                stateError.backup = path.relative(worktreePathFor(REPO_PATH, ticket.id), backup);
                // node/history mínimos pra o state marcado passar no schema — daí em
                // diante ele cai no skip de status "state_corrupted" em dispatchTicket
                // em vez de ser relogado como corrompido a cada tick.
                marked = { task_id: taskId, node: 'escalated', history: [] };
            }
            marked.status = 'state_corrupted';
            marked.state_error = stateError;
            marked.updated_at = at;
            marked.events = [...(Array.isArray(marked.events) ? marked.events : []), {
                type: 'node_error', node, at, detail: `state.json inválido: ${detail}`,
            }];
            // force: o disco está ilegível/fora do schema — não há base a comparar.
            stateWriter.write(dir, marked, { operation: 'state_corrupted', actor: 'watcher', force: true });
        }
    } catch (e) {
        console.error(`[state-error] Task ${taskId}: falha marcando state_corrupted (segue sem redespachar):`, e.message);
    }

    try {
        await notifyBlocked(ticket, taskId, node, 'state_corrupted', dir, marked || {},
            `state.json inválido — ${detail}. Corrija memory/runs/${taskId}/state.json no worktree ` +
            '(detalhes e backup, se houver, em state_error), volte `status` pro valor certo e apague state_error.');
    } catch (e) {
        console.error(`[state-error] Task ${taskId}: falha notificando:`, e.message);
    }
    return result;
}

async function dispatchTicket(ticket) {
    const id = ticket.id;
    const isRecusaQA = ticket.status?.name === 'Recusa QA';
    const liberacao = branchLiberacao(ticket);
    const base = BASE_BY_LIBERACAO[liberacao];

    if (!base) {
        console.warn(`Ticket #${id}: campo "Branch Liberação" ausente ou não reconhecido ("${liberacao}") — pulando.`);
        return { action: 'skip', reason: 'branch_liberacao_invalida' };
    }

    const active = findActiveTask(id);

    if (active?.corrupted) return handleCorruptedState(ticket, active);

    if (!active) {
        // Sem task ativa: ou é a primeira vez que vemos este ticket, ou já tratamos
        // um ciclo anterior (arquivado) e isto pode ser um ciclo novo (ex: nova
        // Recusa QA depois de um commit). Distingue comparando o updated_on que o
        // próprio Redmine reporta contra o updated_at da task arquivada mais
        // recente — sem isso, um ticket que volta como Recusa QA depois de já ter
        // sido commitado uma vez ficaria travado pra sempre (era o bug real do
        // `processed` flat do watcher anterior).
        const archivedAt = mostRecentArchivedCommit(id);
        const ticketUpdatedAt = ticket.updated_on ? new Date(ticket.updated_on).getTime() : null;
        if (archivedAt && ticketUpdatedAt && ticketUpdatedAt <= archivedAt) {
            return { action: 'skip', reason: 'ja_tratado_neste_ciclo' };
        }

        // Recusa QA de ticket que já teve run: o retry é pelo botão do dashboard, que
        // reaproveita o task-id — abrir fetch_ticket aqui criaria a task nova que ele evita.
        const previous = isRecusaQA && !QA_AUTO_NEW_CYCLE ? latestRunForTicket(id) : null;
        if (previous) {
            console.log(`Ticket #${id}: Recusa QA com run anterior (${previous.taskId}) — aguardando "Corrigir recusa QA" no dashboard (WATCHER_RECUSA_QA_NOVO_CICLO=1 abre ciclo novo).`);
            return { action: 'skip', reason: 'recusa_qa_aguardando_retry', taskId: previous.taskId };
        }

        // Pergunta pré-task pendente (ex: working tree sujo no passo 2 do
        // fetch-ticket) — não redespacha até a seção "## Resposta" ser preenchida,
        // senão é só gastar uma sessão nova pra fazer a mesma pergunta de novo (ver
        // notifyPretaskBlocked). Notifica (Redmine + local) uma vez por pergunta.
        if (pretaskAnswerPending(id)) {
            console.warn(`Ticket #${id}: pergunta pré-task pendente em memory/runs/${id}-pretask-question.md — não redespacho fetch_ticket até a seção "## Resposta" ser preenchida.`);
            if (!DRY_RUN) await notifyPretaskBlocked(ticket, id);
            return { action: 'skip', reason: 'pretask_pergunta_pendente' };
        }

        // Spec rascunho dos campos do ticket (ver runSpecDraftGate): gera se não existe,
        // e NUNCA segue enquanto a spec tiver `draft: true` — liberação é manual.
        let draftCheck = await runSpecDraftGate(ticket);
        if (SIMULATE && draftCheck.block && draftCheck.specRel) draftCheck = await simulateSpecDraftReview(ticket, draftCheck);
        if (draftCheck.block) {
            if (draftCheck.reason === 'spec_draft_aguardando_revisao') {
                console.warn(`Ticket #${id}: ${draftCheck.specRel} está com draft: true — ciclo aguardando revisão humana (troque para draft: false para liberar).`);
            }
            return { action: 'skip', reason: draftCheck.reason, status: 'spec-draft', specPath: draftCheck.specRel };
        }

        // Portão de spec — antes de criar worktree ou despachar qualquer agente (ver
        // runTicketSpecGate). Spec incompleta só pausa até o aceite; vale também pra
        // Recusa QA.
        const specCheck = await runTicketSpecGate(ticket);
        if (!specCheck.proceed) {
            const errors = specCheck.result.errors.map(e => e.code);
            if (specCheck.pending) {
                console.warn(`Ticket #${id}: spec (descrição do ticket) incompleta — draft do auto-repair aguardando "${SPEC_APPROVAL_KEYWORD}" no Redmine.`);
                return { action: 'skip', reason: 'spec_aguardando_aprovacao', status: 'spec-pending-approval', errors };
            }
            console.warn(`Ticket #${id}: spec (descrição do ticket) incompleta — aguardando aceite no Redmine. ${specCheck.result.errors.map(e => e.message).join(' ')}`);
            return { action: 'skip', reason: 'spec_aguardando_aceite', status: 'spec-invalid', errors };
        }

        let qaFeedback = [];
        if (isRecusaQA) {
            qaFeedback = await fetchQaFeedback(id);
            if (qaFeedback.length === 0) {
                console.warn(`Ticket #${id}: status Recusa QA mas nenhum comentário encontrado — pulando, sem saber o que corrigir.`);
                return { action: 'skip', reason: 'recusa_qa_sem_comentarios' };
            }
        }

        if (DRY_RUN) {
            console.log(`[dry-run] #${id} (${ticket.subject}) — dispararia fetch_ticket+plan, base origin/${base}`);
            return { action: 'dry-run', node: 'fetch_ticket' };
        }

        for (const repo of SIBLING_REPOS) {
            const repoPath = `${WORKSPACE}/${repo}`;
            if (!fs.existsSync(repoPath)) continue;
            try {
                ensureTicketWorktree(repoPath, id, base);
            } catch (e) {
                console.error(`Falha criando branch #${id} em ${repo}:`, e.message);
            }
        }

        const worktreePath = ensureTicketWorktree(REPO_PATH, id, base);
        if (!worktreePath) {
            console.warn(`Ticket #${id}: sem worktree livre — não disparo agente, tento de novo no próximo tick.`);
            return { action: 'skip', reason: 'worktree_indisponivel' };
        }

        // state.json ainda não existe (quem cria é o próprio fetch_ticket) — não há o
        // que marcar como running; o lease só carimba node_started_at/node_timeout_ms
        // na task nova quando o agente sai. Crash aqui no meio é autocorrigível: sem
        // task, ou com task em in_progress, o próximo tick redespacha normalmente.
        const newTaskLease = {
            runsDir: taskRunsDir(id), prefix: `${id}-`, nodes: ['fetch_ticket', 'plan'],
            startedAt: new Date().toISOString(), timeoutMs: NODE_TIMEOUT_MS,
            gatePath: specGatePath(id),
        };
        // Sem state.json o dashboard não teria o que mostrar até o /fetch-ticket criá-lo
        // (~minutos): o marcador no gate file vira um run sintético "rodando fetch_ticket".
        // Sai no release do lease; o dashboard também o ignora passado o timeout.
        try {
            writeSpecGate(id, {
                ...(readSpecGate(id) || { ticket_id: id }),
                subject: ticket.subject,
                fetch_dispatch: { started_at: newTaskLease.startedAt, timeout_ms: NODE_TIMEOUT_MS },
            });
        } catch (e) {
            console.error(`Ticket #${id}: falha gravando marcador de despacho no gate file:`, e.message);
        }
        const fetchAdmission = dom06.prepareDispatch({
            runDir: path.join(taskRunsDir(id), '_dom06'),
            node: 'fetch_ticket',
            ticketId: id,
            baseBranch: base,
            specHash: null,
            cause: 'dispatch',
        });
        if (!fetchAdmission.dispatch) {
            console.warn(`Ticket #${id}: admissão DOM06 ${fetchAdmission.attempt.result} — fetch_ticket não despachado e não conta como PASS.`);
            return { action: 'skip', reason: `dom06_${String(fetchAdmission.attempt.result).toLowerCase()}`, node: 'fetch_ticket' };
        }
        beginCycle({ ticketId: id, node: 'fetch_ticket' });
        logRun(id, '[watcher]', 'iniciando nós: fetch_ticket, plan');
        let fetchResult = null;
        try {
        fetchResult = await dispatchClaudeSegment({
            ticket, isRecusaQA, qaFeedback, worktreePath, lease: newTaskLease,
            extraEnv: dom06AttemptEnv(fetchAdmission),
            commands: [`/fetch-ticket ${id}`, '/plan (use o task-id que acabou de gerar)'],
            nodes: ['fetch_ticket', 'plan'],
            contextBlock: nodeContextBlock('plan', { ticket, worktreePath }),
            extraNote:
                'Ao terminar o /plan, o handoff.md já deve estar escrito (é o último passo do próprio comando /plan). ' +
                `Assim que o /fetch-ticket terminar de escrever memory/spec/${id}-spec.md — antes do /plan, e independente ` +
                'do resultado do spec-validator abaixo —, rode `node ' + PRISMA_ROOT + '/scripts/lib/spec-enricher.js ' +
                `memory/spec/${id}-spec.md <task-id que acabou de gerar>\`: acrescenta (só APPEND, idempotente) uma seção ` +
                '"## Contexto Histórico" com o que memory/knowledge-graph.json e memory/patterns.md já sabem sobre os ' +
                'arquivos citados na spec (regra inviolável, retrabalho anterior, padrões conhecidos). É best-effort — ' +
                'sempre sai 0, nunca bloqueia o ciclo, não precisa conferir o resultado antes de seguir. ' +
                (specCheck.approvedRepair
                    ? `O watcher já gravou ${specCheck.approvedRepair.specRel} com a descrição do ticket + as seções ` +
                      `${specCheck.approvedRepair.merged.join(', ')} sugeridas por IA e APROVADAS no Redmine por ` +
                      `${specCheck.approvedRepair.by}. No passo 5 do /fetch-ticket, ao reorganizar esse arquivo no formato do ` +
                      'template, preserve literalmente o conteúdo dessas seções aprovadas (não resuma nem reescreva). '
                    : '') +
                (specCheck.completedBy
                    ? `A descrição do ticket está incompleta, mas a spec foi COMPLETADA num comentário (${specCheck.completedBy}) ` +
                      'em resposta ao pedido do watcher — use esse comentário como fonte de Problema/Solução/Critérios de Aceite ' +
                      'ao gravar memory/spec/ (além da descrição). '
                    : '') +
                (specCheck.accepted
                    ? 'A spec deste ticket está incompleta mas foi ACEITA pelo usuário assim mesmo — não pare por causa ' +
                      'do spec-validator e não invente conteúdo pras seções que faltam. '
                    : `Entre o /fetch-ticket e o /plan, rode \`node ${PRISMA_ROOT}/scripts/lib/spec-validator.js memory/spec/${id}-spec.md\`: ` +
                      'se sair com código 1, NÃO rode o /plan — grave status="spec-invalid" no state.json da task e pare (o ' +
                      'orquestrador pede aceite no Redmine no próximo tick; nunca "conserte" a spec inventando conteúdo). ') +
                (specCheck.accepted || specCheck.result.warnings.length
                    ? 'Inclua no context.md, literalmente, este bloco de avisos:\n' +
                      specValidator.formatContextWarnings(
                          specCheck.accepted ? acceptedAsWarnings(specCheck.result) : specCheck.result,
                          { sourceLabel: specCheck.sourceLabel, accepted: specCheck.accepted }) + '\n'
                    : ''),
        });
        } finally {
            endCycle(cycleOutcome(fetchResult));
        }
        recordDom06NodeEffect(fetchAdmission.attemptFile, fetchAdmission.attempt.attempt_id, fetchResult?.code);
        logRun(id, '[watcher]', `nós "fetch_ticket, plan" finalizados (code=${fetchResult.code ?? 'detached'})`);
        if (looksUnavailable(fetchResult.output)) {
            console.warn(`Ticket #${id}: Claude pareceu indisponível rodando fetch_ticket (ver output) — tento de novo no próximo tick.`);
        }
        return { action: 'dispatched', node: 'fetch_ticket' };
    }

    // Task ativa — resume a partir de state.json. state.node já É o próximo nó a
    // rodar, por convenção uniforme de todos os comandos (ver nota acima).
    const { taskId, state, dir } = active;
    let node = state.node;
    let status = state.status;
    const worktreePath = worktreePathFor(REPO_PATH, id);

    // "running" = há (ou havia) um agente rodando este nó. Órfãos já
    // foram tratados no startup (recoverOrphanedNodes: pid gravado morto, ou timeout
    // sem pid) e saíram deste status — o que sobra aqui tem agente vivo ou está dentro
    // do prazo, então redespachar seria dois agentes no mesmo
    // worktree (inclusive no modo cron, com tick mais curto que o nó).
    if (status === 'running') {
        console.log(`Task ${taskId}: nó "${node}" em execução ${nodeLease.describeRunning(state)} — não redespacho.`);
        return { action: 'skip', reason: 'no_em_execucao', taskId, node, agentPid: state.agent_pid ?? null, since: state.node_started_at ?? null };
    }
    // Transição de contrato registrada para o run (scripts/invalidate.js — journal
    // pending-invalidation.jsonl, casos B e C): o nó terminou (sucesso ou falha) — aplica a
    // invalidação antes de despachar qualquer outro nó; a task volta para o /plan.
    if (!DRY_RUN && invalidate.pendingTransitions(state, dir).length) {
        const res = invalidate.resolvePendingInvalidation(state, { runDir: dir });
        if (res.resolved) {
            writeTaskState(dir, state);
            invalidate.syncEvidenceFile(dir, state);
            console.warn(`Task ${taskId}: invalidação pendente aplicada (${res.case}) — artefatos derivados STALE, task volta pro /plan.`);
            ({ node, status } = state);
        }
    }
    // state_corrupted: marcado por handleCorruptedState num tick anterior — o state.json
    // pode voltar a passar no schema depois da marcação, mas continua não confiável até
    // um humano corrigir e trocar o status.
    // blocked/escalated/spec-change-rejected + mensagem do dashboard: interpreta antes; retomando, segue o fluxo normal
    // abaixo (portões e checkHumanInput, que consome a mensagem e a põe no prompt).
    let unblock = null;
    if (HUMAN_INPUT_RESUMABLE_STATUSES.has(status) && !DRY_RUN && !SIMULATE) {
        const result = await interpretBlockedHumanInput(ticket, active);
        if (result.resumed) {
            unblock = result.entry;
            ({ node, status } = state);
        }
    }
    if (status === 'escalated' || status === 'blocked' || status === 'needs_human_review' || status === 'state_corrupted') {
        console.warn(`Task ${taskId}: status "${status}" no nó "${node}" — precisa de intervenção humana, não despacho.`);
        if (!DRY_RUN) await notifyBlocked(ticket, taskId, node, status, dir, state);
        if (!DRY_RUN) await notifyEscalationWebhook(taskId, node, status, dir, state);
        return { action: 'skip', reason: `status_${status}`, taskId, node };
    }
    // interrupted: o watcher recebeu SIGTERM no meio deste nó (GracefulShutdown já
    // comentou no Redmine). Retomada é manual — grave status="in_progress" no state.json.
    if (status === 'interrupted') {
        console.warn(`Task ${taskId}: interrompida via SIGTERM no nó "${state.activeNodeAtInterruption || node}" em ${state.interruptedAt || '?'} — retome manualmente (status="in_progress" no state.json).`);
        return { action: 'skip', reason: 'status_interrupted', taskId, node };
    }
    if (status === 'committed') {
        console.warn(`Task ${taskId}: status "committed" mas ainda em memory/runs/ (não arquivada) — inconsistência, verifique o /commit desta task.`);
        return { action: 'skip', reason: 'committed_nao_arquivada', taskId };
    }
    // session_limit: a sessão anterior deste nó morreu por estouro de janela de
    // contexto/tokens (ver looksLikeSessionLimit). Diferente de "interrupted"
    // (SIGTERM), a retomada aqui é feita pelo dashboard (POST
    // /api/runs/:taskId/resume-session, até 3x — ver resume_count), que grava
    // status="in_progress" antes de redespachar; nunca redespachar sozinho aqui,
    // senão o watcher "gastaria" retomadas do usuário sem ele pedir.
    if (status === 'session_limit') {
        console.warn(`Task ${taskId}: sessão anterior do nó "${state.interrupted_node || node}" interrompida por limite de contexto/tokens em ${state.interrupted_at || '?'} — aguardando retomada manual pelo dashboard.`);
        return { action: 'skip', reason: 'status_session_limit', taskId, node };
    }

    // SPEC_CHANGE proposta pelo /implement (ou rejeitada) — ver runSpecChangeGate.
    // Aprovada, a task volta com node="plan" e segue neste mesmo tick.
    if (status === specChange.PENDING_STATUS || status === specChange.REJECTED_STATUS) {
        const gate = await runSpecChangeGate(ticket, active);
        if (!gate.proceed) return { action: 'skip', reason: gate.reason, status: state.status, taskId, node, specChange: state.spec_change_pending?.id || state.spec_change_rejected?.id || null };
        ({ node, status } = state);
    }

    // Portão de qualidade do plano (plan concluído, implement a despachar) — ver
    // runPlanGate. Re-plan cai no fluxo normal abaixo com node="plan" (inclusive o
    // portão de spec) e o feedback do score no prompt (planFeedbackNote).
    if (needsPlanGate(state)) {
        const gate = await runPlanGate(ticket, active);
        if (!gate.proceed && !gate.replan) {
            console.warn(`Task ${taskId}: plano com score ${gate.result.score}/100 — aguardando revisão humana (plan-escalation).`);
            if (DRY_RUN) return { action: 'dry-run', taskId, node, planScore: gate.result.score };
            return { action: 'skip', reason: 'plan_escalation', status: 'plan-escalation', taskId, node, planScore: gate.result.score };
        }
        if (!DRY_RUN) ({ node, status } = state);
    }

    // Artefatos stale depois de SPEC_CHANGE aprovada (scripts/lib/spec-change.js): sai da
    // lista o que foi regerado; com plan.md/handoff.md ainda stale, nó guardado volta pro
    // /plan (o HOW era da spec antiga).
    if (Array.isArray(state.stale_artifacts) && state.stale_artifacts.length) {
        const refreshed = specChange.refreshStale(state, dir);
        const stale = specChange.staleGate(state, node);
        if (refreshed || stale.rerouted) {
            if (DRY_RUN) console.log(`[dry-run] Task ${taskId}: gravaria state.json: stale_artifacts (${stale.stale.join(', ') || 'regerados'}).`);
            else writeTaskState(dir, state);
        }
        if (stale.rerouted) {
            console.warn(`Task ${taskId}: ${stale.stale.join(', ')} stale depois da SPEC_CHANGE aprovada — ${node} não roda sobre o plano antigo, task volta pro /plan.`);
            node = state.node;
        }
    }

    // Portão de spec antes do /plan (ou revalidação de task já spec-invalid) — ver
    // runTaskSpecGate. Nos demais nós só mantém no context.md os avisos que o portão
    // do ciclo novo registrou (o despacho fetch_ticket+plan pede isso ao agente, mas
    // aqui garante sem depender dele).
    if (node === 'plan' || SPEC_GATE_STATUSES.has(status)) {
        const { result, proceed, pending, clarification } = await runTaskSpecGate(ticket, active);
        if (clarification) {
            console.warn(`Task ${taskId}: critério(s) ${clarification.join(', ')} com [PENDING_CLARIFICATION] — /plan pausado até o esclarecimento.`);
            return { action: 'skip', reason: 'spec_pending_clarification', status: 'spec-invalid', taskId, node, pendingClarification: clarification };
        }
        if (!proceed && pending) {
            console.warn(`Task ${taskId}: spec incompleta — draft do auto-repair (${pending.draft_path}) aguardando "${SPEC_APPROVAL_KEYWORD}" no Redmine.`);
            return { action: 'skip', reason: 'spec_aguardando_aprovacao', status: 'spec-pending-approval', taskId, node, errors: result.errors.map(e => e.code) };
        }
        if (!proceed) {
            console.warn(`Task ${taskId}: spec incompleta — aguardando aceite no Redmine. ${result.errors.map(e => e.message).join(' ')}`);
            return { action: 'skip', reason: 'spec_aguardando_aceite', status: 'spec-invalid', taskId, node, errors: result.errors.map(e => e.code) };
        }
    } else if (!DRY_RUN) {
        const gate = readSpecGate(id);
        if (gate && (gate.status === 'valid' || gate.status === 'accepted') && fs.existsSync(`${dir}/context.md`)) {
            syncSpecWarningsToContext(dir, gate, `descrição do ticket #${id} no Redmine`, gate.status === 'accepted');
        }
    }

    // Portão de drift da spec — ver runSpecDriftGate. Antes de qualquer nó guardado
    // (implement/review/test/verify), e sempre que a task já estiver em spec-drift.
    if (specAuthority.GUARDED_NODES.has(node) || status === specAuthority.DRIFT_STATUS) {
        const gate = await runSpecDriftGate(ticket, active, node);
        if (!gate.proceed) {
            return { action: 'skip', reason: 'spec_drift', status: specAuthority.DRIFT_STATUS, taskId, node, detail: gate.result.reason };
        }
        ({ node, status } = state);
    }

    if (NEVER_AUTO_DISPATCH.has(node)) {
        console.log(`Task ${taskId}: pronta pra /commit — aguardando revisão humana (watcher nunca dispara commit automaticamente).`);
        // Uma vez por pausa (o skip se repete a cada tick).
        const last = Array.isArray(state.events) ? state.events.at(-1) : null;
        if (!DRY_RUN && !(last?.type === 'checkpoint' && last.node === node)) {
            appendEvent(taskId, {
                type: 'checkpoint', node, agent: 'claude',
                detail: `Pausado para aprovação humana antes de ${node}` + (state.risk_level ? ` — risk_level: ${state.risk_level}` : ''),
            }, dir);
        }
        return { action: 'skip', reason: 'aguardando_commit_humano', taskId, node };
    }

    if (DRY_RUN) {
        const preBuild = needsPreBuildGate(state) && !buildValidator.skipRequested() ? ' (antes, rodaria a validação de build pré-implement)' : '';
        console.log(`[dry-run] Task ${taskId} (nó ${node}) — dispararia Claude${preBuild}.`);
        return { action: 'dry-run', taskId, node };
    }

    // Portão de build entre plan e implement — ver runPreBuildGate. Antes do lease:
    // o Maven roda aqui no watcher, não é o agente que está "running".
    let preBuildNote = '';
    if (needsPreBuildGate(state)) {
        // DRY-RUN: mesmo portão, com `mvn compile` simulado (sucesso) no lugar do Maven.
        const gate = await runPreBuildGate(ticket, active, worktreePath, SIMULATE ? { validate: dryRun.simulatedBuild } : undefined);
        if (!gate.proceed) {
            return { action: 'skip', reason: gate.reason, status: 'pre-build-failed', taskId, node };
        }
        preBuildNote = gate.note;
    } else if (node === 'implement' && state.preBuildAccepted && state.preBuildStatus === 'failed') {
        preBuildNote = preBuildAcceptedNote(state); // loop review→implement: erros aceitos continuam valendo
    }

    // Portão de churn (âncora no 1º implement; detecção antes de cada re-implement) —
    // ver runChurnGate. Depois do pré-build: só conta se o implement vai mesmo sair.
    // DRY-RUN pula: o "worktree" é o checkout principal, e a âncora do churn gravaria
    // refs no repo de verdade (e o implement simulado não muda código pra medir).
    if (SIMULATE && needsChurnGate(state)) {
        console.log(`[dry-run] Task ${taskId}: portão de churn pulado (sem worktree git do ticket).`);
    } else if (needsChurnGate(state)) {
        const gate = await runChurnGate(ticket, active, worktreePath);
        if (!gate.proceed) {
            console.warn(`Task ${taskId}: churn de implementação — aguardando revisão humana (churn-escalation).`);
            return { action: 'skip', reason: 'churn_escalation', status: 'churn-escalation', taskId, node };
        }
    }

    let qaFeedback = [];
    if (isRecusaQA && node === 'plan') qaFeedback = await fetchQaFeedback(id);

    // Entre nós: consome mensagens do dashboard antes de despachar o próximo segmento.
    let humanInput = null;
    try {
        humanInput = checkHumanInput(dir);
    } catch (e) {
        console.error(`Task ${taskId}: falha lendo human-input.md (fica pro próximo despacho):`, e.message);
    }

    // Do state lido no início do despacho — acquireNode consome o marcador.
    const recovery = nodeLease.recoveryNote(state);
    // Spec que governa esta execução (execution_spec): o artefato que o nó carimbar só é
    // VALID se a spec atual no fim for a mesma (scripts/invalidate.js stampProduced).
    let executionSpec = null;
    try {
        const active = invalidate.activeSpec(path.resolve(dir, '..', '..', '..'), state, taskId);
        if (active.hash) executionSpec = invalidate.executionSpec(node, { hash: active.hash, version: active.version });
    } catch (e) {
        console.warn(`Task ${taskId}: execution_spec não registrada (${e.message}) — o carimbo do nó compara só com a spec atual.`);
    }
    const nodeAdmission = dom06.prepareDispatch({
        runDir: dir,
        node,
        ticketId: id,
        baseBranch: base,
        specHash: dom06SpecHash(state, worktreePath, id),
        state,
    });
    if (!nodeAdmission.dispatch) {
        console.warn(`Task ${taskId}: admissão DOM06 ${nodeAdmission.attempt.result} (${nodeAdmission.reason}) — ${node} não despachado e não conta como PASS.`);
        return { action: 'skip', reason: `dom06_${String(nodeAdmission.attempt.result).toLowerCase()}`, taskId, node, admission: nodeAdmission.attempt.result };
    }
    const lease = nodeLease.acquireNode(dir, { node, timeoutMs: NODE_TIMEOUT_MS, extra: executionSpec ? { execution_spec: executionSpec } : null });
    if (lease) lease.retriesBefore = Number(state.retries?.[node]) || 0; // node_retry na saída (nodeEvents)
    appendEvent(taskId, {
        type: 'node_start', node, agent: 'claude', ts: lease?.startedAt,
        detail: `Despachando ${node} para Claude` + (recovery ? ' (redespacho após nó órfão)' : ''),
    }, dir);
    checkWrittenState(dir);
    beginCycle({ ticketId: id, taskId, node, dir, leaseStartedAt: lease?.startedAt || null });
    logRun(id, '[watcher]', `iniciando nó ${node}`);
    let segment = null;
    try {

    const testScope = SCOPED_TEST_NODES.has(node) ? stampAffectedServices(id, taskId, dir, worktreePath, base) : null;
    const schemaResult = stampSchemaChecklist(taskId, dir, worktreePath, base);

    segment = await dispatchClaudeSegment({
        ticket, isRecusaQA, qaFeedback, worktreePath, lease,
        commands: [`/${node} ${taskId}`],
        nodes: [node],
        contextBlock: nodeContextBlock(node, { ticket, dir, worktreePath }),
        extraNote: (node === 'commit'
            ? commitRiskNote(state)
            : node === 'plan'
                ? `Se memory/runs/${taskId}/context.md tiver o bloco entre ${specValidator.CONTEXT_BEGIN} e ` +
                  `${specValidator.CONTEXT_END} (avisos do portão de spec), preserve-o ao reescrever o arquivo.` + planFeedbackNote(state) + invalidate.promptNote(state)
                : '') + (testScope ? testScopeNote(node, testScope.services) : '') + schemaChecklistNote(schemaResult) + preBuildNote + recovery + humanInputNote(humanInput, unblock) + cycleReplayer.replayPromptNote(state) + qaRetryNote(taskId, node),
        extraEnv: {
            ...(testScope ? { AFFECTED_SERVICES: testScope.services.join(',') } : {}),
            ...dom06AttemptEnv(nodeAdmission),
        },
    });
    if (node !== 'commit') recordDom06NodeEffect(nodeAdmission.attemptFile, nodeAdmission.attempt.attempt_id, segment?.code);
    } finally {
        endCycle(cycleOutcome(segment));
    }
    const { output, code, stderr: stderrBuffer } = segment;
    logRun(id, '[watcher]', `nó ${node} finalizado (code=${code ?? 'detached'})`);

    // Estouro de contexto/tokens da sessão — diferente de UNAVAILABLE_SIGNATURES
    // abaixo (aquele é indisponibilidade do provedor, retry silencioso no próximo
    // tick). Aqui o run fica visível como "session_limit" (badge no dashboard) e só
    // é redespachado por retomada manual (POST /api/runs/:taskId/resume-session,
    // até 3x). Só detectável em --follow (stderrBuffer só é populado nesse modo —
    // ver spawnAgent) e só quando o processo saiu com erro de fato.
    if (code !== 0 && looksLikeSessionLimit(stderrBuffer || '')) {
        const fresh = readTaskState(dir);
        const at = new Date().toISOString();
        writeTaskState(dir, {
            ...fresh,
            status: 'session_limit',
            session_interrupted: true,
            interrupted_node: node,
            interrupted_at: at,
            updated_at: at,
        });
        console.warn(`Task ${taskId}: sessão do nó "${node}" interrompida por estouro de contexto/tokens (sinal detectado no stderr) — aguardando retomada manual pelo dashboard.`);
    } else if (looksUnavailable(output)) {
        // Sinal de indisponibilidade (limite de uso, erro de auth) detectado na saída —
        // sem um segundo agente pra assumir, a única ação possível é avisar e deixar o
        // próximo tick tentar de novo (ver UNAVAILABLE_SIGNATURES).
        console.warn(`Task ${taskId}: Claude pareceu indisponível no nó "${node}" (sinal detectado na saída) — próximo tick tenta de novo.`);
    }

    return { action: 'dispatched', taskId, node };
}

// Exceção num ticket (ex: state.json de outra forma inesperado) derrubava o tick
// inteiro via tick().catch — os tickets seguintes da lista nem eram vistos.
function cycleOutcome(result) {
    if (!result) return 'failed';
    if (!FOLLOW && !SIMULATE) return 'dispatched';
    return result.code === 0 ? 'completed' : 'failed';
}

async function dispatchTicketSafe(ticket) {
    // SIGTERM recebido: nada de despacho novo enquanto o GracefulShutdown encerra.
    if (watcherState.shuttingDown) return { action: 'skip', reason: 'shutdown_em_andamento' };
    try {
        return await dispatchTicket(ticket);
    } catch (e) {
        console.error(`Ticket #${ticket.id}: erro inesperado no despacho (demais tickets seguem):`, e);
        return { action: 'skip', reason: 'erro_inesperado', error: e.message };
    }
}

async function tick() {
    // DRY-RUN: o agente é simulado, então o binário `claude` não importa.
    const claudeAvailable = SIMULATE || commandAvailable('claude');
    if (!claudeAvailable) console.error('AVISO: binário `claude` não encontrado no PATH.');

    try {
        finalizePendingCostRuns();
    } catch (e) {
        console.error('[custo] falha fechando métricas pendentes (tick segue normal):', e.message);
    }

    // Ciclos que terminaram depois do tick anterior (agente destacado) entram aqui.
    syncAcRegistrySafe();
    syncKnowledgeGraphSafe();
    runMemoryConsolidatorSafe();
    // PR aberto por um /commit desde o tick anterior → webhook (antes da limpeza, que
    // move os runs pro _archive do checkout principal) e worktrees do ticket saem do disco.
    await notifyOpenedPrsSafe();
    await cleanupWorktreesAfterPrOpenSafe();

    // Retry de Recusa QA pedido no dashboard: traz o run de volta pro worktree antes da
    // reidratação abaixo, que então o enxerga como task ativa (node=implement).
    let qaRetryIds = [];
    try {
        qaRetryIds = await consumeQaRetrySignals();
    } catch (e) {
        console.error('[qa-retry] falha varrendo sinais de retry (tick segue):', e.message);
    }

    let tickets = await fetchAssignedTickets();

    // Reidrata tickets com task ativa local que já saíram de Aprovada/Recusa QA
    // (ex: moveram pra "Em Desenvolvimento") — sem isso o watcher nunca mais os
    // veria depois do primeiro segmento. Ver findLocallyActiveTicketIds.
    const knownIds = new Set(tickets.map(t => t.id));
    for (const id of new Set([...qaRetryIds, ...findLocallyActiveTicketIds()])) {
        if (knownIds.has(id)) continue;
        const ticket = await fetchTicketById(id);
        if (ticket) { tickets.push(ticket); knownIds.add(id); }
        else console.warn(`Ticket #${id}: task ativa local, mas não achei o ticket no Redmine (removido/inacessível?) — pulando por enquanto.`);
    }

    if (ONLY_TICKET) tickets = tickets.filter(t => t.id === ONLY_TICKET);
    const log = loadWatcherLog();
    log.last_tick_at = new Date().toISOString();

    // Modo normal (sem --follow, ex: cron): um segmento por ticket por tick, como
    // sempre — quem redespacha o próximo é o próximo tick. Com --follow, o humano
    // está observando ao vivo e normalmente quer ver a demanda inteira andar, não
    // precisar re-rodar o comando manualmente a cada nó — então, aqui, encadeia
    // despachos pro MESMO ticket dentro deste processo até parar de avançar (bloqueado,
    // escalado, pronto pra commit, ou Claude indisponível). Isto NÃO muda a
    // arquitetura de checkpoint por segmento: cada despacho aqui dentro continua
    // sendo uma invocação separada, com state.json escrito entre uma e outra — só a
    // decisão de "encadear sem eu precisar apertar enter de novo" que é nova. Cap de
    // segurança (MAX_FOLLOW_SEGMENTS) evita loop infinito se houver um bug fazendo o
    // estado nunca convergir.
    const MAX_FOLLOW_SEGMENTS = 30;
    let dispatched = 0, skipped = 0;
    for (const ticket of tickets) {
        if (watcherState.shuttingDown) break;
        try {
            await syncQaRejection(ticket);
        } catch (e) {
            console.error(`Ticket #${ticket.id}: falha gravando ticket_status/qa_rejection (despacho segue):`, e.message);
        }
        let result = claudeAvailable
            ? await dispatchTicketSafe(ticket)
            : { action: 'skip', reason: 'claude_indisponivel' };
        log.tickets[ticket.id] = { subject: ticket.subject, status: ticket.status?.name, ...result, at: new Date().toISOString() };
        if (result.action === 'dispatched') dispatched++; else skipped++;
        console.log(`Ticket #${ticket.id} (${ticket.subject}): ${JSON.stringify(result)}`);

        // DRY-RUN encadeia como --follow: o agente simulado roda dentro deste processo,
        // e o ciclo plan→commit inteiro sai numa execução só.
        if ((FOLLOW || SIMULATE) && !DRY_RUN && claudeAvailable) {
            let segments = 1;
            while (result.action === 'dispatched' && segments < MAX_FOLLOW_SEGMENTS && !watcherState.shuttingDown) {
                result = await dispatchTicketSafe(ticket);
                segments++;
                log.tickets[ticket.id] = { subject: ticket.subject, status: ticket.status?.name, ...result, at: new Date().toISOString() };
                console.log(`Ticket #${ticket.id} (${ticket.subject}), segmento ${segments}: ${JSON.stringify(result)}`);
            }
            if (segments >= MAX_FOLLOW_SEGMENTS) {
                console.warn(`Ticket #${ticket.id}: atingiu o limite de ${MAX_FOLLOW_SEGMENTS} segmentos encadeados em --follow — parando por segurança (não deveria acontecer em uso normal; investigue se o estado está oscilando).`);
            }
        }
    }

    if (!DRY_RUN) saveWatcherLog(log);
    // Com --follow o /commit pode ter terminado dentro deste tick.
    if (FOLLOW) syncAcRegistrySafe();
    if (FOLLOW) await notifyOpenedPrsSafe();
    // Nós despachados neste tick já saíram (dispatchClaudeSegment espera o agente).
    syncKnowledgeGraphSafe();

    const prefix = DRY_RUN || SIMULATE ? '[dry-run] ' : '';
        console.log(`${prefix}Tick concluído: ${tickets.length} ticket(s) — ${dispatched} despachado(s), ${skipped} pulado(s).`);
}

// Recuperação de nó órfão no startup, antes de qualquer chamada ao Redmine (ver
// scripts/lib/node-lease.js). Escaneia memory/runs/*/state.json do checkout
// principal e de cada worktree de ticket. Nó comum órfão volta pra "in_progress" e é
// redespachado pelo tick logo em seguida (findLocallyActiveTicketIds o reidrata) a
// partir do state.node atual; commit órfão vira "needs_human_review" e não é
// redespachado. Respeita --ticket e --dry-run.
function runsRootsForStartup() {
    const worktreesDir = `${REPO_PATH}/.claude/worktrees`;
    const runsDirs = [RUNS_DIR];
    if (fs.existsSync(worktreesDir)) {
        for (const d of fs.readdirSync(worktreesDir, { withFileTypes: true })) {
            if (d.isDirectory()) runsDirs.push(`${worktreesDir}/${d.name}/memory/runs`);
        }
    }
    return runsDirs;
}

function recoverOrphanedNodes() {
    const runsDirs = runsRootsForStartup();
    return nodeLease.recoverOrphans(runsDirs, {
        defaultTimeoutMs: NODE_TIMEOUT_MS,
        dryRun: DRY_RUN,
        filter: taskScopeFilter(),
    });
}

// Filtro por task-id das varreduras de startup (órfãos, rotação de runs): --ticket=<id>
// restringe a um ticket; em DRY-RUN, só os tickets do fixture — nunca tasks reais.
function taskScopeFilter() {
    if (SIMULATE) return taskId => DRY_RUN_TICKETS.some(t => taskId.startsWith(`${t.id}-`));
    return ONLY_TICKET ? taskId => taskId.startsWith(`${ONLY_TICKET}-`) : undefined;
}

// ---------------------------------------------------------------------------------
// Registro de Critérios de Aceite (.graph/ac-registry.json no checkout principal — ver
// scripts/lib/ac-registry.js). Quem grava o fim do ciclo é o agente do /commit
// (status "committed"; "completed" é legado; "fully_merged" vem do polling de PRs), e
// sem --follow ele roda destacado, depois do watcher sair — então o watcher não "vê" a
// transição acontecer. Em vez de um gancho pontual, varre a cada tick as tasks
// (ativas e arquivadas) com status terminal e faz upsert da spec do ticket; o
// specHash torna isso idempotente (só escreve se a spec mudou desde a indexação).
// Ticket com um ciclo NÃO terminal em andamento fica de fora: a spec pode estar
// sendo reescrita pelo /plan do ciclo novo, e o registro guarda o que foi entregue.
// Efeito colateral puro: falha aqui nunca derruba o tick.
const AC_REGISTRY_PATH = `${REPO_PATH}/.graph/ac-registry.json`;
const AC_TERMINAL_STATUSES = new Set(['completed', 'committed', 'fully_merged']);

function ticketIdOfTask(taskId, state) {
    const fromState = state?.redmine_ticket?.id;
    if (fromState != null && /^\d+$/.test(String(fromState))) return String(fromState);
    const m = /^(\d+)-/.exec(taskId);
    return m ? m[1] : null;
}

// Um item por ticket: a task terminal mais recente (por updated_at) e se há ciclo
// não terminal ativo. Escaneia worktrees de ticket + checkout principal.
function collectAcCandidates() {
    const worktreesDir = `${REPO_PATH}/.claude/worktrees`;
    const roots = [REPO_PATH];
    if (fs.existsSync(worktreesDir)) {
        for (const d of fs.readdirSync(worktreesDir, { withFileTypes: true })) {
            if (d.isDirectory()) roots.push(`${worktreesDir}/${d.name}`);
        }
    }
    const byTicket = new Map();
    for (const root of roots) {
        for (const runsDir of [`${root}/memory/runs`, `${root}/memory/runs/_archive`]) {
            if (!fs.existsSync(runsDir)) continue;
            const archived = runsDir.endsWith('/_archive');
            for (const d of fs.readdirSync(runsDir, { withFileTypes: true })) {
                if (!d.isDirectory() || d.name === '_archive') continue;
                const state = readStateJson(`${runsDir}/${d.name}`);
                // dry_run: run do modo DRY-RUN (ticket fictício) — nunca entra no registro.
                if (!state || state.dry_run) continue;
                const ticketId = ticketIdOfTask(d.name, state);
                if (!ticketId || (ONLY_TICKET && Number(ticketId) !== ONLY_TICKET)) continue;
                const c = byTicket.get(ticketId) || { ticketId, done: null, open: false };
                if (AC_TERMINAL_STATUSES.has(state.status)) {
                    const at = new Date(state.updated_at || state.started_at || 0).getTime();
                    if (!c.done || at > c.done.at) c.done = { taskId: d.name, root, at };
                } else if (!archived) {
                    c.open = true;
                }
                byTicket.set(ticketId, c);
            }
        }
    }
    return [...byTicket.values()];
}

function syncAcRegistry() {
    const summary = { indexed: [], unchanged: 0, withoutACs: [] };
    for (const c of collectAcCandidates()) {
        if (!c.done || c.open) continue;
        const specPath = `${c.done.root}/memory/spec/${c.ticketId}-spec.md`;
        if (!fs.existsSync(specPath)) continue;
        const content = fs.readFileSync(specPath, 'utf8');
        const acs = acRegistry.extractACs(content, c.ticketId);
        if (!acs.criteria.length) summary.withoutACs.push(c.ticketId);
        if (DRY_RUN) continue;
        const { changed } = acRegistry.updateRegistry(c.ticketId, acs, {
            registryPath: AC_REGISTRY_PATH,
            specContent: content,
            dependsOn: acRegistry.extractDependencies(content, c.ticketId),
            runTaskId: c.done.taskId,
        });
        if (changed) summary.indexed.push(c.ticketId); else summary.unchanged++;
    }
    if (summary.indexed.length) console.log(`[ac-registry] indexado(s): ${summary.indexed.join(', ')} → ${AC_REGISTRY_PATH}`);
    for (const id of summary.withoutACs) console.warn(`[ac-registry] ticket #${id}: ciclo concluído, mas a spec não tem itens em "## Critérios de Aceite".`);
    return summary;
}

// DRY-RUN: registros derivados de memory/ (ACs, knowledge graph, patterns) são do
// projeto real — o ticket fictício não entra neles.
function syncAcRegistrySafe() {
    if (SIMULATE) return null;
    try {
        return syncAcRegistry();
    } catch (e) {
        console.error('[ac-registry] falha sincronizando o registro de ACs (tick segue normal):', e.message);
        return null;
    }
}

// ---------------------------------------------------------------------------------
// Knowledge Graph de rastreabilidade (memory/knowledge-graph.json no checkout principal
// — ver scripts/lib/knowledge-graph.js). Mesma estratégia do registro de ACs: o /commit
// roda destacado e o polling de PRs muda status em background, então em vez de um
// gancho por transição o watcher varre a cada tick (início e fim) todas as tasks,
// ativas e arquivadas, e faz merge append-only de ticket/spec/PRs/arquivos tocados.
// Idempotente: só escreve quando algo novo apareceu (nó, aresta, status de PR).
// Arquivos vêm do diff da branch nos worktrees do ticket (app-back + irmãos), uma vez
// por ticket por varredura. Efeito colateral puro: falha aqui nunca derruba o tick.
const KNOWLEDGE_GRAPH_PATH = process.env.KNOWLEDGE_GRAPH_PATH || `${REPO_PATH}/memory/knowledge-graph.json`;

function collectKnowledgeFacts() {
    const worktreesDir = `${REPO_PATH}/.claude/worktrees`;
    const roots = [REPO_PATH];
    if (fs.existsSync(worktreesDir)) {
        for (const d of fs.readdirSync(worktreesDir, { withFileTypes: true })) {
            if (d.isDirectory()) roots.push(`${worktreesDir}/${d.name}`);
        }
    }
    const filesByTicket = new Map();
    const facts = [];
    for (const root of roots) {
        for (const runsDir of [`${root}/memory/runs`, `${root}/memory/runs/_archive`]) {
            if (!fs.existsSync(runsDir)) continue;
            for (const d of fs.readdirSync(runsDir, { withFileTypes: true })) {
                if (!d.isDirectory() || d.name.startsWith('_') || d.name.startsWith('.')) continue;
                const state = readStateJson(`${runsDir}/${d.name}`);
                if (!state || state.dry_run) continue; // ver collectAcCandidates
                const ticketId = knowledgeGraph.ticketIdOf(d.name, state);
                if (!ticketId || (ONLY_TICKET && Number(ticketId) !== ONLY_TICKET)) continue;
                if (!filesByTicket.has(ticketId)) {
                    filesByTicket.set(ticketId, knowledgeGraph.ticketFiles(REPO_PATH, ticketId, state.redmine_ticket?.base_branch || 'development'));
                }
                const spec = knowledgeGraph.specNodeId(ticketId);
                facts.push(knowledgeGraph.taskFacts({
                    taskId: d.name, state, files: filesByTicket.get(ticketId), redmineUrl: REDMINE_URL,
                    specExists: fs.existsSync(`${root}/${spec}`) || fs.existsSync(`${REPO_PATH}/${spec}`),
                }));
            }
        }
    }
    return facts;
}

function syncKnowledgeGraph() {
    const facts = collectKnowledgeFacts();
    if (DRY_RUN) return { changed: false, tasks: facts.length };
    const { changed, graph } = knowledgeGraph.updateGraph(
        g => facts.reduce((acc, f) => knowledgeGraph.mergeFacts(g, f) || acc, false),
        KNOWLEDGE_GRAPH_PATH);
    if (changed) console.log(`[knowledge-graph] atualizado: ${Object.keys(graph.nodes).length} nó(s), ${graph.edges.length} aresta(s) → ${KNOWLEDGE_GRAPH_PATH}`);
    return { changed, tasks: facts.length };
}

function syncKnowledgeGraphSafe() {
    if (SIMULATE) return null; // ver syncAcRegistrySafe
    try {
        return syncKnowledgeGraph();
    } catch (e) {
        console.error('[knowledge-graph] falha sincronizando o grafo (tick segue normal):', e.message);
        return null;
    }
}

// ---------------------------------------------------------------------------------
// Consolidação periódica de padrões de falha/custo (memory/patterns.md) — ver
// scripts/memory-consolidator.js. Mesma estratégia dos dois syncs acima: em vez de
// um gancho no exato momento em que um run termina, varre a cada tick quantos runs
// já estão em status terminal e compara com o contador salvo em
// memory/consolidator-state.json; só reconsolida depois de `threshold` (10) runs
// novos. Efeito colateral puro — falha aqui nunca derruba o tick.
const CONSOLIDATOR_STATE_PATH = process.env.CONSOLIDATOR_STATE_PATH || `${REPO_PATH}/memory/consolidator-state.json`;
const CONSOLIDATOR_PATTERNS_PATH = process.env.CONSOLIDATOR_PATTERNS_PATH || `${REPO_PATH}/memory/patterns.md`;

function runMemoryConsolidator() {
    return memoryConsolidator.maybeRun({
        repoRoot: REPO_PATH,
        runsDir: RUNS_DIR,
        statePath: CONSOLIDATOR_STATE_PATH,
        patternsPath: CONSOLIDATOR_PATTERNS_PATH,
        dryRun: DRY_RUN,
    });
}

// Com --ticket não roda: patterns.md e o contador agregam os runs de todos os tickets,
// e consolidar só os do filtro reescreveria a memória global com uma amostra parcial.
function runMemoryConsolidatorSafe() {
    if (SIMULATE || ONLY_TICKET) return null; // ver syncAcRegistrySafe
    try {
        const r = runMemoryConsolidator();
        if (r.ran) console.log(`[memory-consolidator] consolidado (${r.completedRuns} runs completados) → ${CONSOLIDATOR_PATTERNS_PATH}`);
        return r;
    } catch (e) {
        console.error('[memory-consolidator] falha consolidando padrões (tick segue normal):', e.message);
        return null;
    }
}

// ---------------------------------------------------------------------------------
// Polling pós-abertura dos PRs (consistência cross-repo) — ver
// scripts/lib/pr-status-poll.js. Só tasks "committed" (ativas ou arquivadas, no
// checkout principal e em cada worktree); grava status/last_checked_at por repo,
// evento escalation se um repo MERGED e outro DECLINED, e "fully_merged" quando
// todos mergearam. Roda em background: o tick não espera por ele.
// --pr-status-only: roda só um ciclo (ignorando o intervalo) e sai.
const PR_STATUS_POLL_INTERVAL_MS = prStatusPoll.resolvePollIntervalMs();
const PR_STATUS_ONLY = process.argv.includes('--pr-status-only');
const PR_STATUS_MARKER = `${RUNS_DIR}/pr-status-poll.json`;

function prStatusRoots() {
    const worktreesDir = `${REPO_PATH}/.claude/worktrees`;
    const roots = [{ dir: RUNS_DIR }];
    if (fs.existsSync(worktreesDir)) {
        for (const d of fs.readdirSync(worktreesDir, { withFileTypes: true })) {
            if (d.isDirectory()) roots.push({ dir: `${worktreesDir}/${d.name}/memory/runs`, worktree: d.name });
        }
    }
    return roots;
}

// Pós-merge (Task 51): todos os PRs da task MERGED no Bitbucket (o polling acabou de
// gravar fully_merged) → para o preview do ticket, se houver, e remove os worktrees
// dele (scripts/lib/worktree-cleanup.js). Não roda no /verify: o PR só existe depois
// do /commit, então é aqui, na confirmação do merge pela API, que o cleanup é seguro.
//
// Não remove se outra task do mesmo ticket (ex: ciclo de Recusa QA aberto depois)
// ainda está andando no worktree. O state.json da task costuma morar no próprio
// worktree do ticket — que vai ser apagado —, então o run é copiado antes pra
// memory/runs do checkout principal (_archive/<task>) e o resultado gravado lá.
async function onTaskFullyMerged({ taskId, dir, state }, deps = {}) {
    const cleanup = deps.cleanupWorktrees || cleanupWorktrees;
    const postNote = deps.postNote || postRedmineNote;
    const worktreesDir = deps.worktreesDir || `${REPO_PATH}/.claude/worktrees`;
    const runsDir = deps.runsDir || RUNS_DIR;
    // Task-id com data no começo (2026-09-19-...) não é ticket — "2026" apagaria o worktree errado.
    const fromTaskId = /^\d{4}-\d{2}-\d{2}-/.test(taskId) ? null : (taskId.match(/^(\d+)-/) || [])[1];
    const ticketId = String(state?.redmine_ticket?.id || fromTaskId || '');
    if (!/^\d+$/.test(ticketId)) {
        console.warn(`[pr-check] Task ${taskId}: mergeada, mas sem ticket numérico — worktrees não removidos automaticamente.`);
        return null;
    }
    if (state?.worktrees_cleaned_at) return null;
    const other = (deps.findActiveTask || findActiveTask)(Number(ticketId));
    if (other && other.taskId !== taskId && (other.corrupted || !['committed', 'fully_merged'].includes(other.state?.status))) {
        console.warn(`[pr-check] Task ${taskId}: mergeada, mas a task ${other.taskId} do ticket #${ticketId} ainda está ativa — worktrees mantidos.`);
        return null;
    }
    if (DRY_RUN && !deps.force) {
        console.log(`[dry-run] #${ticketId}: pararia o preview e removeria os worktrees do ticket (task ${taskId} mergeada).`);
        return null;
    }

    // Tira o run de dentro do worktree antes de apagá-lo.
    let stateDir = dir;
    const rel = path.relative(worktreesDir, dir);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
        stateDir = fs.existsSync(`${runsDir}/${taskId}`) ? `${runsDir}/${taskId}` : `${runsDir}/_archive/${taskId}`;
        fs.mkdirSync(path.dirname(stateDir), { recursive: true });
        fs.cpSync(dir, stateDir, { recursive: true, force: true });
    }

    const result = await cleanup(ticketId, { worktreesDir });
    const check = readStateChecked(stateDir);
    const fresh = check.state || check.raw || state;
    const next = { ...fresh, pr_status: 'merged' };
    if (result.errors.length) next.worktrees_cleanup_errors = result.errors;
    else delete next.worktrees_cleanup_errors;
    if (result.removed.length || !result.errors.length) next.worktrees_cleaned_at = new Date().toISOString();
    stateWriter.write(stateDir, next, { operation: 'merge_cleanup', actor: 'watcher', base: baseOf(fresh) });
    checkWrittenState(stateDir);

    const rels = paths => paths.map(p => path.relative(REPO_PATH, p));
    if (result.errors.length) {
        await postNote(ticketId,
            `⚠️ PR mergeado, mas o cleanup automático dos worktrees falhou em parte.\n` +
            (result.removed.length ? `Removidos: ${rels(result.removed).join(', ')}\n` : '') +
            `Falharam (remova manualmente com \`git worktree remove --force <caminho>\` no repo dono):\n` +
            result.errors.map(e => `- ${e.path ? path.relative(REPO_PATH, e.path) : '(ticket)'}: ${e.error}`).join('\n'));
    } else if (result.removed.length) {
        await postNote(ticketId, '✅ PR mergeado. Worktrees do ticket removidos automaticamente.');
    }
    return result;
}

// ---------------------------------------------------------------------------------
// Limpeza dos worktrees logo após o PR aberto (commit.md passo 7.6, desde 2026-09-29).
// Até aqui só existia a do pós-merge (onTaskFullyMerged, acima) e os worktrees de
// app-back e irmãos ficavam no disco — e em `git worktree list` — o tempo todo que o
// PR esperava revisão. É uma varredura por tick, não um gancho no fim do /commit,
// porque em modo destacado o watcher nem vê o agente sair.
//
// Candidata = task "committed" (o /commit terminou e se arquivou) no memory/runs do
// worktree do ticket, com ao menos uma URL em state.json.pull_request e sem
// worktrees_removed_on_pr_open_at. Push/PR pulado por falta de credencial = nenhuma
// URL = worktree fica intacto (ainda serve pro push/PR manual).
//
// Adia (tenta no próximo tick, sem gravar nada) se: outra task do ticket ainda anda;
// o agente do /commit pode estar vivo (agent_pid vivo, ou gravou o state.json há menos
// de PR_OPEN_CLEANUP_GRACE_MS); o preview do dashboard está no ar pro ticket — o dev
// está testando o Draft, e parar por baixo dele é pior que esperar.
// Worktree com mudança rastreada não commitada é mantido (skipDirty): nunca --force
// por cima de sobra que não entrou em PR. A branch local não é tocada.
// Os runs do worktree vão antes pro memory/runs/_archive do checkout principal — senão
// somem do dashboard e do polling de PRs. Uma tentativa por task: erro de remoção vira
// worktrees_cleanup_errors + evento e o que sobrar sai no cleanup pós-merge.
// WORKTREE_CLEANUP_ON_PR_OPEN=0 desliga (volta a limpar só depois do merge).
const PR_OPEN_CLEANUP_ENABLED = process.env.WORKTREE_CLEANUP_ON_PR_OPEN !== '0';
const PR_OPEN_CLEANUP_GRACE_MS = 2 * 60 * 1000;

// URLs de PR aberto em state.json.pull_request: um objeto por repo ({url} ou URL
// solta, legado) ou, em task bem antiga, uma entrada plana.
function openedPrUrls(pr) {
    const one = v => (typeof v === 'string' ? v : v && typeof v === 'object' ? v.url : null);
    if (!pr) return [];
    const urls = typeof pr === 'string' || typeof pr.url === 'string' ? [one(pr)] : Object.values(pr).map(one);
    return urls.filter(u => typeof u === 'string' && /^https?:\/\//.test(u));
}

// Sem confirmação do dashboard, conta como "no ar" — adiar é barato, derrubar um
// preview em uso não. Dashboard fora do ar = nenhum preview (são filhos dele).
async function previewRunningViaDashboard(ticketId, base = dashboardBase()) {
    try {
        const res = await fetch(`${base}/api/preview/${encodeURIComponent(ticketId)}/status`, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) return true;
        const st = await res.json();
        return !!st && st.phase !== 'idle';
    } catch (e) {
        return e.cause?.code !== 'ECONNREFUSED';
    }
}

// Só os runs do próprio ticket (<ticket> ou <ticket>-slug). Worktree criado a partir
// de uma branch que ainda versiona memory/runs (ex.: development) carrega runs
// legados de OUTROS tickets, committed e com URL de PR — sem esse filtro eles faziam
// o worktree de um ticket recém-criado parecer "PR aberto" e ser apagado no meio do
// /fetch-ticket (#43746, 2026-10-02).
function worktreeTaskDirs(wtRuns, ticketId) {
    const ours = name => name === String(ticketId) || name.startsWith(`${ticketId}-`);
    return [wtRuns, `${wtRuns}/_archive`].flatMap(base => (fs.existsSync(base)
        ? fs.readdirSync(base, { withFileTypes: true })
            .filter(e => e.isDirectory() && e.name !== '_archive' && ours(e.name))
            .map(e => ({ taskId: e.name, dir: `${base}/${e.name}` }))
        : []));
}

async function cleanupWorktreesAfterPrOpen(deps = {}) {
    if (!PR_OPEN_CLEANUP_ENABLED && !deps.force) return [];
    const worktreesDir = deps.worktreesDir || `${REPO_PATH}/.claude/worktrees`;
    const runsDir = deps.runsDir || RUNS_DIR;
    const cleanup = deps.cleanupWorktrees || cleanupWorktrees;
    const previewRunning = deps.previewRunning || previewRunningViaDashboard;
    const isAlive = deps.pidAlive || pidAlive;
    const findActive = deps.findActiveTask || findActiveTask;
    const nowMs = deps.now ? deps.now() : Date.now();
    if (!fs.existsSync(worktreesDir)) return [];

    const results = [];
    for (const d of fs.readdirSync(worktreesDir, { withFileTypes: true })) {
        if (!d.isDirectory() || !/^\d+$/.test(d.name)) continue;
        const ticketId = d.name;
        if (ONLY_TICKET && ONLY_TICKET !== Number(ticketId)) continue;
        const taskDirs = worktreeTaskDirs(`${worktreesDir}/${ticketId}/memory/runs`, ticketId);
        const due = taskDirs.map(t => ({ ...t, state: readStateJson(t.dir) }))
            .filter(t => t.state?.status === 'committed' && !t.state.worktrees_removed_on_pr_open_at && openedPrUrls(t.state.pull_request).length);
        if (!due.length) continue;

        const defer = reason => {
            console.log(`[pr-open-cleanup] #${ticketId}: ${reason} — worktrees mantidos, tento no próximo tick.`);
            results.push({ ticketId, deferred: reason });
        };
        const other = findActive(Number(ticketId));
        if (other && (other.corrupted || other.state?.status !== 'committed')) { defer(`task ${other.taskId} ainda ativa`); continue; }
        const live = due.find(t => isAlive(t.state.agent_pid) || nowMs - Date.parse(t.state.updated_at || 0) < PR_OPEN_CLEANUP_GRACE_MS);
        if (live) { defer(`agente do /commit de ${live.taskId} pode ainda estar rodando`); continue; }
        if (await previewRunning(ticketId)) { defer('preview do dashboard no ar'); continue; }
        if (DRY_RUN && !deps.force) {
            console.log(`[dry-run] #${ticketId}: removeria os worktrees do ticket (PR aberto: ${due.map(t => t.taskId).join(', ')}).`);
            continue;
        }

        // Tira os runs de dentro do worktree antes de apagá-lo.
        const copied = [];
        for (const t of taskDirs) {
            const dst = `${runsDir}/_archive/${t.taskId}`;
            const existed = fs.existsSync(dst);
            fs.mkdirSync(path.dirname(dst), { recursive: true });
            fs.cpSync(t.dir, dst, { recursive: true, force: true });
            if (!existed) copied.push(dst);
        }

        let result;
        try {
            result = await cleanup(ticketId, { worktreesDir, skipDirty: true, stopPreview: async () => ({ stopped: false }) });
        } catch (e) {
            result = { removed: [], kept: [], errors: [{ path: null, error: e.message }] };
        }
        result.kept = result.kept || [];
        // Worktree do app-back ficou (sujo ou falhou): o run continua morando nele —
        // desfaz as cópias, senão dashboard e polling veem a task duas vezes.
        const backGone = !fs.existsSync(`${worktreesDir}/${ticketId}`);
        if (!backGone) for (const c of copied) fs.rmSync(c, { recursive: true, force: true });

        const at = new Date(nowMs).toISOString();
        const rel = p => (p ? path.relative(REPO_PATH, p) : '(ticket)');
        const parts = [];
        if (result.removed.length) parts.push(`removidos: ${result.removed.map(rel).join(', ')}`);
        if (result.kept.length) parts.push(`mantidos (mudança não commitada): ${result.kept.map(k => rel(k.path)).join(', ')}`);
        if (result.errors.length) parts.push(`falharam: ${result.errors.map(e => `${rel(e.path)} (${e.error})`).join('; ')}`);
        const detail = `Limpeza pós-abertura do PR — ${parts.join(' · ') || 'nenhum worktree a remover'}. Branch local preservada.`;
        for (const t of due) {
            const dir = backGone ? `${runsDir}/_archive/${t.taskId}` : t.dir;
            const cur = readStateJson(dir) || t.state;
            const next = { ...cur, worktrees_removed_on_pr_open_at: at };
            if (result.errors.length) next.worktrees_cleanup_errors = result.errors;
            else delete next.worktrees_cleanup_errors;
            next.events = [...(Array.isArray(next.events) ? next.events : []), nodeEvents.buildEvent({
                ts: at, type: result.errors.length ? 'worktree_cleanup_failed' : 'worktrees_removed', node: 'commit', agent: 'watcher', detail,
            })];
            stateWriter.write(dir, next, { operation: 'pr_open_cleanup', actor: 'watcher', base: baseOf(cur) });
            checkWrittenState(dir);
        }
        (result.errors.length ? console.warn : console.log)(`[pr-open-cleanup] #${ticketId}: ${detail}`);
        results.push({ ticketId, ...result });
    }
    return results;
}

async function cleanupWorktreesAfterPrOpenSafe() {
    if (SIMULATE) return null; // DRY-RUN não abre PR nem remove worktree real
    try {
        return await cleanupWorktreesAfterPrOpen();
    } catch (e) {
        console.error('[pr-open-cleanup] falha na limpeza de worktrees pós-PR (tick segue normal):', e.message);
        return null;
    }
}

// ---------------------------------------------------------------------------------
// Notificação via webhook (NOTIFY_WEBHOOK_URL, scripts/notify.js): PR aberto / Draft
// HIGH-RISK (varredura por tick) e escalação pra humano (ponto do notifyBlocked). Regras
// de quando e dedup em scripts/lib/cycle-notifications.js. Sem a variável não faz nada;
// falha de envio só vira warn — nunca muda status nem state.json.
function notificationRunsDirs() {
    const worktreesDir = `${REPO_PATH}/.claude/worktrees`;
    const dirs = [RUNS_DIR];
    if (fs.existsSync(worktreesDir)) {
        for (const d of fs.readdirSync(worktreesDir, { withFileTypes: true })) {
            if (d.isDirectory()) dirs.push(`${worktreesDir}/${d.name}/memory/runs`);
        }
    }
    return dirs;
}

async function notifyOpenedPrsSafe() {
    if (DRY_RUN || SIMULATE) return [];
    try {
        const sent = await cycleNotifications.sweepOpenedPrs({
            runsDirs: notificationRunsDirs(),
            filter: ONLY_TICKET ? taskId => taskId.startsWith(`${ONLY_TICKET}-`) : undefined,
        });
        for (const s of sent) console.log(`[notify] Task ${s.taskId}: PR ${s.draft ? 'Draft HIGH-RISK' : 'aberto'} — notificação ${s.result?.sent ? 'enviada' : 'não entregue'}.`);
        return sent;
    } catch (e) {
        console.warn('[notify] falha na varredura de PRs abertos (tick segue normal):', e.message);
        return [];
    }
}

async function notifyEscalationWebhook(taskId, node, status, dir, state) {
    if (SIMULATE) {
        console.log(`[dry-run] Webhook de escalação (${status} em ${node}) para ${taskId} NÃO enviado.`);
        return null;
    }
    try {
        const r = await cycleNotifications.notifyEscalation({ dir, taskId, state, node, status });
        if (r) console.log(`[notify] Task ${taskId}: escalação (${status} em ${node}) — notificação ${r.sent ? 'enviada' : 'não entregue'}.`);
    } catch (e) {
        console.warn(`[notify] Task ${taskId}: falha notificando escalação (despacho segue):`, e.message);
    }
}

function startPrStatusPolling({ force = false } = {}) {
    return prStatusPoll.startPrStatusPolling({
        token: process.env.BITBUCKET_API_TOKEN,
        intervalMs: PR_STATUS_POLL_INTERVAL_MS,
        markerPath: PR_STATUS_MARKER,
        force,
        getStatus: getPRStatus,
        roots: prStatusRoots,
        defaultWorkspace: process.env.BITBUCKET_WORKSPACE || null,
        dryRun: DRY_RUN,
        filter: ONLY_TICKET ? taskId => taskId.startsWith(`${ONLY_TICKET}-`) : undefined,
        onFullyMerged: task => onTaskFullyMerged(task),
        // state.json arquivado de task antiga pode já estar fora do schema — só
        // revalida (e loga) depois da escrita se estava válido antes.
        writeState: (dir, state) => {
            const wasValid = readStateChecked(dir).valid;
            stateWriter.write(dir, state, { operation: 'pr_status_poll', actor: 'watcher' });
            if (wasValid) checkWrittenState(dir);
        },
    });
}

// memory/runs/.watcher-mode: modo do último tick (dry-run vs live), lido pelo dashboard
// (GET /api/watcher/mode) pro banner "DRY-RUN MODE". O tick live regrava — sem isso o
// banner ficaria ligado depois de voltar pro modo real. --dry-run (argv) não escreve nada.
function writeWatcherModeFile() {
    if (DRY_RUN) return;
    try {
        dryRun.writeModeFile(RUNS_DIR, SIMULATE
            ? { mode: 'dry-run', dry_run: true, pid: process.pid, fixture: path.relative(REPO_PATH, DRY_RUN_FIXTURE_PATH), tickets: DRY_RUN_TICKETS.map(t => t.id) }
            : { mode: 'live', dry_run: false, pid: process.pid });
    } catch (e) {
        console.error('[mode] falha gravando memory/runs/.watcher-mode (tick segue):', e.message);
    }
}

async function main() {
    // Um writer por REPO_PATH, antes de qualquer escrita do tick (custo, sync, recovery).
    // --dry-run só lê: não trava e não cria arquivo. Recusa = exit 75, sem seguir o tick.
    if (!DRY_RUN && !watcherLock.acquireForProcess({ repoPath: REPO_PATH, role: SIMULATE ? 'simulate' : 'watcher' })) {
        process.exit(watcherLock.EXIT_LOCKED);
    }
    if (SIMULATE) {
        console.log('[dry-run] Modo DRY-RUN ativo — nenhuma chamada externa real');
        console.log(`[dry-run] Fixture: ${DRY_RUN_FIXTURE_PATH} (${DRY_RUN_TICKETS.map(t => `#${t.id}`).join(', ')})`);
    }
    // Antes de tudo: SIGTERM em qualquer ponto daqui pra frente cai no shutdown graceful.
    if (!DRY_RUN) {
        new GracefulShutdown({
            postNote: postRedmineNote,
            writeRuntime: writeWatcherRuntime,
        }).register(watcherState);
    }
    loadPreviousRuntime();
    writeWatcherRuntime();
    writeWatcherModeFile();
    if (SIMULATE && PR_STATUS_ONLY) {
        console.log('[dry-run] --pr-status-only ignorado: consultaria o Bitbucket.');
        return;
    }
    if (PR_STATUS_ONLY) {
        await startPrStatusPolling({ force: true }).settle();
        return;
    }
    // state.json.*.tmp de escrita interrompida (crash entre o write e o rename): o
    // state.json continua íntegro e o tmp é descartado — nunca aplicado.
    if (!DRY_RUN) {
        try {
            const removed = stateWriter.cleanupOrphans(runsRootsForStartup().flatMap(stateWriter.runDirsOf));
            if (removed.length) console.warn(`[state-writer] ${removed.length} tmp/lock órfão(s) de escrita interrompida descartado(s): ${removed.map(f => path.relative(REPO_PATH, f)).join(', ')}`);
        } catch (e) {
            console.error('[state-writer] falha limpando tmp órfãos (sigo com o tick):', e.message);
        }
    }
    try {
        recoverOrphanedNodes();
    } catch (e) {
        console.error('[recovery] falha escaneando nós órfãos (sigo com o tick):', e.message);
    }
    // Rotação de runs antigos pra memory/archive/ (política e env vars em
    // scripts/cleanup-runs.js). Depois do scan de órfãos: run "running" com lease
    // vencido já virou in_progress/needs_human_review, e nenhum dos dois é arquivado.
    if (!/^(1|true|sim)$/i.test(process.env.DISABLE_AUTO_CLEANUP || '')) {
        try {
            cleanupRuns.runCleanup({
                repoRoot: REPO_PATH,
                dryRun: DRY_RUN,
                filter: taskScopeFilter(),
            });
        } catch (e) {
            console.error('[cleanup] falha na rotação de runs (sigo com o tick):', e.message);
        }
    }
    let prPoller = null;
    try {
        // DRY-RUN: o polling consulta o Bitbucket, e nenhum PR foi aberto de verdade.
        if (!SIMULATE) prPoller = startPrStatusPolling();
    } catch (e) {
        console.error('[pr-check] falha iniciando polling de PRs (sigo com o tick):', e.message);
    }
    await tick();
    // Timer é unref(): sem isto um tick de cron sairia no meio de uma escrita.
    if (prPoller) await prPoller.settle();
    if (!watcherState.shuttingDown) {
        // Só o laço do dashboard sabe quando é o próximo tick (intervalo conta a partir da saída).
        watcherState.nextPollAt = watcherState.tickIntervalMs ? new Date(Date.now() + watcherState.tickIntervalMs).toISOString() : null;
        writeWatcherRuntime();
    }
}

if (require.main === module) {
    if (HEALTH_CHECK) process.exitCode = runHealthCheck();
    else main().catch(console.error);
}

// Exports pra teste: permitem validar a lógica de decisão (findActiveTask,
// mostRecentArchivedCommit, dispatchTicket em --dry-run) com fixtures sintéticos de
// memory/runs/, sem disparar claude de verdade nem tocar o Redmine real.
module.exports = {
    handleCorruptedState, readStateJson,
    findActiveTask, mostRecentArchivedCommit, dispatchTicket, appendEvent,
    latestRunForTicket, syncQaRejection, consumeQaRetrySignals, qaRetryNote,
    NEVER_AUTO_DISPATCH, looksUnavailable, looksLikeSessionLimit, findLocallyActiveTicketIds,
    notifyBlocked, alreadyNotified, markNotified,
    pretaskQuestionPath, pretaskAnswerPending, notifyPretaskBlocked,
    runTicketSpecGate, runTaskSpecGate, runSpecDriftGate, SPEC_DRIFT_COMMENT_PREFIX, runSpecChangeGate, SPEC_CHANGE_COMMENT_PREFIX, findApprovalReply, fetchRepliesAfter, specGatePath, readSpecGate, syncSpecWarningsToContext, specAccepted,
    specDraftRel, SPEC_APPROVAL_KEYWORD,
    runSpecDraftGate, specDraftComment, SPEC_DRAFT_COMMENT_PREFIX, fillSpecDraftGaps,
    commitRiskNote, checkHumanInput, peekHumanInput, humanInputNote, recoverOrphanedNodes, NODE_TIMEOUT_MS,
    startPrStatusPolling, prStatusRoots, PR_STATUS_POLL_INTERVAL_MS, onTaskFullyMerged,
    cleanupWorktreesAfterPrOpen, openedPrUrls, notifyOpenedPrsSafe, notifyEscalationWebhook,
    costLedgerPath, readCostLedger, startCostRun, finishCostRun, finalizePendingCostRuns,
    captureTranscript, transcriptStatus,
    collectChangedFiles, stampAffectedServices, testScopeNote,
    collectSchemaDiff, stampSchemaChecklist, schemaChecklistNote,
    needsPlanGate, runPlanGate, planFeedbackNote, PLAN_GATE_COMMENT_PREFIX, PLAN_MAX_REPLANS,
    needsPreBuildGate, runPreBuildGate, worktreeFingerprint, formatPreBuildComment, PRE_BUILD_COMMENT_PREFIX,
    needsChurnGate, runChurnGate, formatChurnComment, CHURN_COMMENT_PREFIX,
    syncAcRegistry, collectAcCandidates, AC_REGISTRY_PATH,
    syncKnowledgeGraph, collectKnowledgeFacts, KNOWLEDGE_GRAPH_PATH,
    runMemoryConsolidator, runMemoryConsolidatorSafe, CONSOLIDATOR_STATE_PATH, CONSOLIDATOR_PATTERNS_PATH,
    watcherState, createWatcherState, writeWatcherRuntime, beginCycle, endCycle, runHealthCheck, WATCHER_RUNTIME_FILE,
    // Despacho fora do tick (scripts/lib/node-dispatcher.js → replay de ciclo).
    fetchTicketById, postRedmineNote, BASE_BY_LIBERACAO,
    // Log de agente em tempo real (dashboard GET /api/runs/:taskId/agent-log[/stream]).
    logPathFor, logRun,
};
