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
const { execSync, execFileSync, spawn, spawnSync } = require('child_process');
const specValidator = require('./lib/spec-validator');
const specRepairer = require('./lib/spec-repairer');
const { withClaudeAccount, resolveClaudeAccount, listClaudeAccounts, accountCostMetadata, routedPluginProof, evaluatePluginProof } = require('./lib/claude-account');
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
const planSignals = require('./lib/plan-signals');
const wouldRoute = require('./lib/would-route');
const modelRoutingPolicy = require('./lib/model-routing-policy');
const modelRouting = require('./lib/model-routing');
const classifierAuthority = require('./lib/classifier-authority');
const classifierShadow = require('./lib/classifier-shadow');
const classifierSelection = require('./lib/classifier-selection');
const routingRun = require('./lib/routing-run');
const schemaWatcher = require('./lib/schema-watcher');
const prStatusPoll = require('./lib/pr-status-poll');
const { getPRStatus } = require('./check-pr-status');
const { cleanupWorktrees, dashboardBase } = require('./lib/worktree-cleanup');
const acRegistry = require('./lib/ac-registry');
const acProvenance = require('./lib/ac-provenance');
const specAuthority = require('./lib/spec-authority');
const specArtifacts = require('./lib/spec-artifacts');
const specChange = require('./lib/spec-change');
// Pedido de autorização humana estruturado (status authorization-pending, PRI-180).
const authorization = require('./lib/authorization');
const cleanupRuns = require('./cleanup-runs');
const stateWriter = require('./state-writer');
const cas = require('./cas');
const knowledgeGraph = require('./lib/knowledge-graph');
const memoryConsolidator = require('./memory-consolidator');
const churnDetector = require('./lib/churn-detector');
const cycleReplayer = require('./lib/cycle-replayer');
const qaJournal = require('./lib/redmine-journal-fetcher');
const qaCycles = require('./lib/qa-cycles');
const qaIngest = require('./lib/qa-rejection-ingest');
const { GracefulShutdown } = require('./lib/graceful-shutdown');
const watcherLock = require('./lib/watcher-lock');
const dispatchReservation = require('./lib/dispatch-reservation');
const watcherHealth = require('./lib/watcher-health');
const promptContext = require('./lib/prompt-context');
const { redmineFetch: realRedmineFetch } = require('./lib/redmine-fetch');
const specGenerator = require('./lib/spec-generator');
const cycleNotifications = require('./lib/cycle-notifications');
const humanInputIntent = require('./lib/human-input-intent');
const dom06 = require('./lib/dom06-attempt');
const decompositionRuntime = require('./lib/decomposition-runtime');
const decompositionVisit = require('./lib/decomposition-visit');

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
        return active && (active.corrupted || !['committed', 'handed_back_qa'].includes(active.state.status));
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
// PRI-181 c0b (RRC-PRI181-004 r5.1 §3.2): C1–C3 (identidade, store, diagnóstico) só com
// WATCHER_QA_DIAGNOSTICO=1. Desligado (padrão, inclusive ausente) = comportamento C0 de
// 2cb6b89^ (syncQaRejectionC0). Ligar no consumidor é gate próprio (Promotion Gate, DB-06,
// RRC-PRI263-001) — não basta editar o .env.
const QA_DIAGNOSTICO = /^(1|true|sim)$/i.test(process.env.WATCHER_QA_DIAGNOSTICO || '');
const QA_RETRY_SIGNAL = 'retry-signal.json';
const qaRetryTasks = new Set(); // task-ids cujo sinal foi consumido neste processo (nota no prompt)
// Motivos estáveis de qa_retry_blocked (PRI-184) — alinhados a .graph/schemas/state.schema.json.
const QA_RETRY_BLOCKED_REASONS = new Set([
    'destino_ocupado', 'spec_ausente', 'changelog_invalido',
    'state_fora_schema', 'ticket_ausente', 'worktree_ausente',
]);

// Persiste bloqueio do sinal de retry: campo atual + evento append-only uma vez por motivo.
// Não mexe em updated_at (mesmo critério de syncQaRejection). DRY_RUN/SIMULATE: no-op.
function recordQaRetryBlocked(dir, reason) {
    if (!QA_RETRY_BLOCKED_REASONS.has(reason)) {
        console.warn(`[qa-retry] ${path.basename(dir)}: motivo de bloqueio não catalogado (${reason}) — não gravado.`);
        return;
    }
    if (DRY_RUN || SIMULATE) return;
    const check = readStateChecked(dir);
    const state = check.state || check.raw;
    if (!state || typeof state !== 'object') {
        console.warn(`[qa-retry] ${path.basename(dir)}: não dá para gravar qa_retry_blocked (${reason}) — state ilegível.`);
        return;
    }
    const events = Array.isArray(state.events) ? state.events : [];
    const already = events.some(e => e && e.type === 'qa_retry_blocked' && e.detail === reason);
    const current = state.qa_retry_blocked;
    if (already && current && current.reason === reason) return;
    const ts = new Date().toISOString();
    const next = { ...state, qa_retry_blocked: { reason, at: ts } };
    if (!already) {
        next.events = [...events, {
            type: 'qa_retry_blocked', node: state.node || 'implement', ts, at: ts, detail: reason,
        }];
    }
    stateWriter.write(dir, next, { operation: 'qa_retry_blocked', actor: 'watcher', base: baseOf(state) });
    if (check.valid) checkWrittenState(dir);
}

function clearQaRetryBlocked(state) {
    if (!state || state.qa_retry_blocked === undefined) return state;
    const { qa_retry_blocked: _blocked, ...rest } = state;
    return rest;
}

function mapSpecBlockReason(message) {
    const text = String(message || '');
    if (/changelog|JSON inválido|versão .*changelog|Branch Liberação/i.test(text)) return 'changelog_invalido';
    return 'spec_ausente';
}

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

// Comportamento C0 (cópia literal de syncQaRejection em 2cb6b89^, PR #50/#60): usado com
// WATCHER_QA_DIAGNOSTICO desligado. Não grava rejection_key/identity_quality/
// transition_journal_id/qa_diagnosis, não promove legado e não toma lock de ingestão.
// Oráculos: lib/qa-rejection-c0-oracle.test.js e lib/qa-retry-watcher-c0-oracle.test.js.
async function syncQaRejectionC0(ticket) {
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

// Grava a mudança de status do ticket no run mais recente. Não mexe em updated_at
// (decide findActiveTask/mostRecentArchivedCommit) nem em run com nó rodando (o agente
// reescreve o state.json ao sair — fica pro próximo tick).
//
// PRI-181 C1: com status Recusa QA, relê journals mesmo se ticket_status não mudou
// (DB-01b / between_polls). Identidade = journal → 13 + rejection_key; N-08 via
// trava por chave no ingest. Sem Diagnosis Record (C2).
async function syncQaRejection(ticket) {
    if (!QA_DIAGNOSTICO) return syncQaRejectionC0(ticket);
    const name = ticket.status?.name;
    if (!name) return null;
    const latest = latestRunForTicket(ticket.id);
    if (!latest || latest.state.status === 'running') return latest;

    const statusChanged = latest.state.ticket_status !== name;
    const rejected = qaJournal.isQaRejectedStatus(name);
    // Fora de Recusa QA: só grava quando o status mudou (comportamento anterior).
    if (!statusChanged && !rejected) return latest;

    const next = { ...latest.state, ticket_status: name };
    let changed = statusChanged;

    if (rejected) {
        let contextMd = '';
        try { contextMd = fs.readFileSync(`${latest.dir}/context.md`, 'utf8'); } catch { /* sem context.md */ }
        const journals = await qaIngest.fetchIssueJournals(ticket.id);
        const found = journals ? qaJournal.noteFromJournals(journals) : null;
        const at = new Date().toISOString();
        const result = qaIngest.ingestFromJournals({
            ticketId: ticket.id,
            journals: journals || [],
            state: next,
            contextMd,
            noteSource: found,
            at,
            repoPath: REPO_PATH,
            ticketFallbackRejectedAt: ticket.updated_on || at,
        });
        if (result.blocked.length) {
            console.warn(`Ticket #${ticket.id}: ingestão C1 bloqueada por N-08 (contention): ${result.blocked.map(b => b.rejection_key).join(', ')}`);
        }
        if (result.changed) {
            Object.assign(next, {
                qa_rejection: result.state.qa_rejection,
                qa_rejections: result.state.qa_rejections,
            });
            changed = true;
            if (result.ingested.length) {
                console.log(`Ticket #${ticket.id}: Recusa QA C1 — ${result.ingested.length} identidade(s) em ${latest.taskId} (retry pelo botão "Corrigir recusa QA" do dashboard).`);
            }
            // PRI-181 c2b-1 (Q1=A): o store por repo (memory/qa-diagnosis/) e o ponteiro
            // state.qa_diagnosis deixam de ter writer. O Diagnosis Record passa ao store por
            // run (qa-diagnosis-store/-model), que a c2b-2 liga com reserva e commit (SDD §4.3).
            // Até lá, com a flag ligada, só a ingestão C1 roda; qa_diagnosis legado fica intacto.
        } else if (statusChanged && !next.qa_rejection) {
            // Transporte falhou / sem journals: fallback legado (C0) sem inventar chave.
            const rejection = {
                note: null,
                rejected_at: ticket.updated_on || at,
                journal_id: null,
                rejection_key: null,
                identity_quality: 'UNKNOWN',
                transition_journal_id: null,
            };
            next.qa_rejections = qaCycles.recordRejection(latest.state, contextMd, { ...rejection, at });
            next.qa_rejection = rejection;
            changed = true;
            console.log(`Ticket #${ticket.id}: Recusa QA detectada (fallback UNKNOWN) — gravada em ${latest.taskId}.`);
        }
    }

    if (!changed) return latest;
    if (DRY_RUN) return { ...latest, state: next };
    stateWriter.write(latest.dir, next, { operation: 'qa_rejection_detected', actor: 'watcher', base: baseOf(latest.state) });
    if (latest.valid) checkWrittenState(latest.dir);
    return { ...latest, state: next };
}

// Sinais de retry deixados pelo dashboard. Pra cada um: garante o worktree do ticket
// (o merge pode tê-lo apagado), move o run pra <worktree>/memory/runs/<task-id> se ele
// estiver em outro lugar (_archive, checkout principal), copia os artefatos de spec
// que o worktree recriado não herdou, confere node=implement / status=in_progress,
// remove o sinal e devolve os ids de ticket pro tick despachar. Spec com spec_hash
// ausente nos dois checkouts, ou spec_path fora de memory/spec/, mantém o sinal.
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
    if (state && typeof state === 'object' && check.valid === false && check.reason === 'schema') {
        console.warn(`[qa-retry] ${taskId}: state fora do schema — sinal mantido, implement não despachado.`);
        recordQaRetryBlocked(dir, 'state_fora_schema');
        return null;
    }
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
    const existingWorktree = fs.existsSync(worktreePathFor(REPO_PATH, ticketId)) ? worktreePathFor(REPO_PATH, ticketId) : null;
    const preview = specArtifacts.assess({ mainRoot: REPO_PATH, workRoot: existingWorktree, state, taskId });
    if (preview.blocked) {
        console.warn(`[qa-retry] ${taskId}: ${preview.reason} — sinal mantido, implement não despachado.`);
        recordQaRetryBlocked(dir, mapSpecBlockReason(preview.reason));
        return null;
    }
    const target = `${taskRunsDir(ticketId)}/${taskId}`;
    if (path.resolve(dir) !== path.resolve(target)) {
        const ticket = await fetchTicketById(ticketId);
        if (!ticket) {
            console.warn(`[qa-retry] ${taskId}: ticket #${ticketId} não encontrado no Redmine — sinal mantido.`);
            recordQaRetryBlocked(dir, 'ticket_ausente');
            return null;
        }
        const base = BASE_BY_LIBERACAO[branchLiberacao(ticket)];
        if (!base) {
            console.warn(`[qa-retry] ${taskId}: "Branch Liberação" do #${ticketId} ausente/não reconhecida — sinal mantido.`);
            recordQaRetryBlocked(dir, 'changelog_invalido');
            return null;
        }
        for (const repo of SIBLING_REPOS) {
            const repoPath = `${WORKSPACE}/${repo}`;
            if (!fs.existsSync(repoPath)) continue;
            try { ensureTicketWorktree(repoPath, ticketId, base); } catch (e) { console.error(`[qa-retry] falha criando worktree #${ticketId} em ${repo}:`, e.message); }
        }
        if (!ensureTicketWorktree(REPO_PATH, ticketId, base)) {
            console.warn(`[qa-retry] ${taskId}: sem worktree do #${ticketId} — sinal mantido.`);
            recordQaRetryBlocked(dir, 'worktree_ausente');
            return null;
        }
        if (fs.existsSync(target)) {
            console.error(`[qa-retry] ${taskId}: já existe ${target} — não sobrescrevo; resolva manualmente (sinal mantido em ${dir}).`);
            recordQaRetryBlocked(dir, 'destino_ocupado');
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
    const workRoot = path.resolve(target, '..', '..', '..');
    const imported = specArtifacts.importMissing({
        mainRoot: REPO_PATH, workRoot, state: readStateJson(target) || state, taskId,
    });
    if (imported.blocked) {
        console.warn(`[qa-retry] ${taskId}: ${imported.reason} — sinal mantido, implement não despachado.`);
        recordQaRetryBlocked(target, mapSpecBlockReason(imported.reason));
        return null;
    }
    // Não consome o sinal nem reabre o implement se a spec sumir entre a
    // importação e o baseline, ou se não for possível registrar sua versão/hash.
    if (!rebaselineSpecForQaRetry(target, taskId)) return null;
    // Churn é por ciclo: as rodadas do ciclo aprovado não contam no retry (mesmo task-id).
    const churnWorktree = worktreePathFor(REPO_PATH, ticketId);
    try {
        if (fs.existsSync(churnWorktree) && churnDetector.resetCycle(churnWorktree, taskId)) {
            console.log(`[qa-retry] ${taskId}: contagem de churn do ciclo anterior zerada.`);
        }
    } catch (e) {
        console.error(`[qa-retry] ${taskId}: falha zerando o churn do ciclo anterior:`, e.message);
    }
    const fresh = readStateJson(target) || state;
    // Carimbo da limpeza pós-PR e churn são do ciclo anterior: o próximo /commit tem que
    // limpar de novo e o portão de churn recomeça a contagem. Limpa também qa_retry_blocked
    // (campo atual; events append-only permanecem).
    const staleChurn = ['churnReport', 'churnAccepted', 'churnEscalationNotifiedAt'].some(k => fresh[k] !== undefined);
    const needsReopen = fresh.node !== 'implement' || fresh.status !== 'in_progress'
        || fresh.worktrees_removed_on_pr_open_at || staleChurn || fresh.qa_retry_blocked;
    if (needsReopen) {
        const {
            worktrees_removed_on_pr_open_at: _cleaned,
            churnReport: _churnReport, churnAccepted: _churnAccepted, churnEscalationNotifiedAt: _churnNotified,
            qa_retry_blocked: _blocked,
            ...reopened
        } = fresh;
        stateWriter.write(target, { ...reopened, node: 'implement', status: 'in_progress' }, { operation: 'qa_retry_reopen', actor: 'watcher', base: baseOf(fresh) });
        checkWrittenState(target);
    }
    if (imported.copied.length) {
        const current = readStateJson(target);
        if (current) {
            const at = new Date().toISOString();
            current.events = [...(Array.isArray(current.events) ? current.events : []), {
                type: 'spec_imported', node: 'implement', ts: at, at,
                detail: `retry de Recusa QA: artefatos copiados do checkout principal sem sobrescrever: ${imported.copied.join(', ')}`,
            }];
            stateWriter.write(target, clearQaRetryBlocked(current), { operation: 'qa_retry_spec_import', actor: 'watcher', base: baseOf(current) });
            checkWrittenState(target);
        }
    }
    fs.rmSync(`${target}/${QA_RETRY_SIGNAL}`, { force: true });
    qaRetryTasks.add(taskId);
    console.log(`[qa-retry] ${taskId}: retry de Recusa QA #${(readStateJson(target) || fresh).qa_retry_count || 1} — run em ${path.relative(REPO_PATH, target)}, implement a despachar.`);
    return ticketId;
}

// O /commit anterior pode acrescentar notas de correção: só o retry explícito
// admite a spec atual como baseline, registrando o hash e mantendo a versão.
// false mantém o sinal pendente; o gate de drift continua sendo obrigatório.
function rebaselineSpecForQaRetry(dir, taskId) {
    try {
        const s = readStateJson(dir);
        if (!s) throw new Error('state.json indisponível para rebaseline');
        const root = path.resolve(dir, '..', '..', '..');
        const rel = specAuthority.specRelFor(s, taskId);
        const probe = specAuthority.baselineFields(root, rel, 'qa_retry', undefined, s);
        if (!probe) {
            if (!s.spec_hash) return true; // run legado sem spec/sem baseline
            console.warn(`[qa-retry] ${taskId}: spec ${rel} ausente ou ilegível no rebaseline — sinal mantido, implement não despachado.`);
            recordQaRetryBlocked(dir, 'spec_ausente');
            return false;
        }
        if (probe.spec_hash === s.spec_hash) return true;
        // applyBaseline: run versionado registra o hash novo como rebaseline da mesma
        // spec_version (nota de correção do /commit não é SPEC_CHANGE — versão não sobe).
        const { spec_drift: _drift, ...next } = s;
        const fields = specAuthority.applyBaseline(next, {
            root, specPath: rel, by: 'qa_retry', taskId,
            reason: 'retry de Recusa QA: spec pós-/commit (notas de correção) vira o baseline — versão mantida',
        });
        if (!fields) throw new Error(`spec ${rel} ausente durante applyBaseline`);
        if (fields.version_error) throw new Error(fields.version_error);
        const at = fields.spec_hash_at;
        next.events = [...(Array.isArray(next.events) ? next.events : []), {
            type: 'spec_baseline', node: 'implement', ts: at, at,
            detail: `retry de Recusa QA: spec_hash ${fields.spec_hash.slice(0, 12)} de ${fields.spec_path} (spec pós-/commit) vira o baseline`,
        }];
        stateWriter.write(dir, { ...clearQaRetryBlocked(next), updated_at: at }, { operation: 'qa_retry_rebaseline', actor: 'watcher', base: baseOf(s) });
        checkWrittenState(dir);
        return true;
    } catch (e) {
        console.error(`[qa-retry] ${taskId}: falha regravando spec_hash — sinal mantido, implement não despachado:`, e.message);
        recordQaRetryBlocked(dir, mapSpecBlockReason(e.message));
        return false;
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

// memory/ é local, mas branches antigas podem conter spec/decisions/flows
// versionados. Mantém esses diretórios e liga só as entradas ausentes ao checkout
// principal. Arquivos e links existentes nunca são substituídos; runs/ é próprio.
function linkLocalMemory(repoPath, worktreePath) {
    if (path.resolve(repoPath) === path.resolve(worktreePath)) return;
    const src = `${repoPath}/memory`;
    if (!fs.existsSync(src)) return;
    const dst = `${worktreePath}/memory`;
    fs.mkdirSync(`${dst}/runs`, { recursive: true });
    const mergeable = new Set(['spec', 'decisions', 'flows']);
    function linkMissing(source, target, mergeDirectories) {
        let existing;
        try { existing = fs.lstatSync(target); } catch (e) {
            if (e.code !== 'ENOENT') throw e;
        }
        if (!existing) {
            try { fs.symlinkSync(source, target); } catch (e) {
                if (e.code !== 'EEXIST') throw e; // outra escrita venceu; não sobrescreve
            }
            return;
        }
        // Não segue links existentes (inclusive quebrados), nem links na origem
        // para recursão: evita escrever por um alias ou entrar em ciclos.
        if (!mergeDirectories || !existing.isDirectory() || !fs.lstatSync(source).isDirectory()) return;
        for (const name of fs.readdirSync(source)) {
            if (name === '.DS_Store') continue;
            linkMissing(path.join(source, name), path.join(target, name), true);
        }
    }
    for (const name of fs.readdirSync(src)) {
        if (name === 'runs' || name === '.DS_Store') continue;
        linkMissing(path.join(src, name), path.join(dst, name), mergeable.has(name));
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
        // Pedido de autorização que falhou/ficou incerto não é aprovado por mensagem: a
        // retomada só o tira de cena (histórico). Aprovar é só pelo dashboard.
        if (s.pending_authorization) {
            s.authorization_history = [...(Array.isArray(s.authorization_history) ? s.authorization_history : []),
                { id: s.pending_authorization.id, event: 'superseded', by: 'human_input', via: 'watcher', at, phase: s.pending_authorization.phase }];
            delete s.pending_authorization;
        }
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
    const howToResume = status === authorization.STATUS
        ? `Decida no dashboard, como aprovador cadastrado: Aprovar escolhendo o banco (o Prisma executa o SQL governado e confere antes/depois), ` +
          `Recusar ou "Já apliquei manualmente". Mensagem livre (dashboard ou Redmine) não aprova.`
        : HUMAN_INPUT_RESUMABLE_STATUSES.has(status)
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

// PRI-233 (PRI-205 S4, T6): admissão recusada por roteamento ON com configuração
// inválida. Um aviso por projeto e por assinatura (routing-run.blockedNotice), pelo
// mesmo canal do bloqueio pré-task: comentário no Redmine (fora de --follow) e
// notificação local. O marcador em RUNS_DIR guarda os tickets barrados (Dashboard, T9)
// e sai quando a configuração volta a ser OFF ou ON válida.
function routingBlockedMarkerPath() {
    return `${RUNS_DIR}/routing-admission-blocked.json`;
}

function clearRoutingBlockedMarker() {
    try { fs.rmSync(routingBlockedMarkerPath(), { force: true }); } catch { /* best-effort */ }
}

async function notifyRoutingAdmissionBlocked(ticket, cfg) {
    const markerPath = routingBlockedMarkerPath();
    let previous = null;
    try { previous = JSON.parse(fs.readFileSync(markerPath, 'utf8')); } catch { previous = null; }
    const { notify, marker } = routingRun.blockedNotice(previous, cfg, { ticketId: ticket.id, at: new Date().toISOString() });
    fs.mkdirSync(RUNS_DIR, { recursive: true });
    fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2));
    if (!notify) return;

    const msg =
        `[Watcher] Roteamento de modelo ligado (mode ON) com configuração inválida neste projeto: ` +
        `${cfg.cause} (${cfg.detail}${cfg.transient ? ', leitura transitória repetida' : ''}). ` +
        `Nenhuma Run nova é admitida enquanto isso durar (este ticket #${ticket.id} e os próximos); ` +
        `Runs já em andamento não mudam.\n\n` +
        // PRI-310 (S5.1): "decomposition": "on" está reservado até o PR de liberação da S5.
        (cfg.cause === 'DECOMPOSITION_RESERVED'
            ? `A chave "decomposition": "on" ainda está reservada (decomposição do Implement em subtarefas, PRI-287) e não é aceita; remova-a ou use "off". `
            : '') +
        `Saídas: corrigir a policy ou o policy_ref (id, versão, sha256) em ${modelRoutingPolicy.ROUTING_CONFIG_REL}, ` +
        `ou desligar explicitamente com { "mode": "OFF" } nesse arquivo. ` +
        `Confira com: node scripts/validate-config.js --severity error. O próximo tick retoma sozinho.`;
    const delivered = await deliverRoutingNotice(marker, {
        ticketId: ticket.id, msg, title: 'Roteamento ON inválido: admissão recusada',
        localBody: `${cfg.cause} — ver ${modelRoutingPolicy.ROUTING_CONFIG_REL}`,
    });
    fs.writeFileSync(markerPath, JSON.stringify(delivered, null, 2));
}

// Aviso de roteamento pelo canal existente: comentário no Redmine (fora de --follow, como
// notifyBlocked) e notificação local. Devolve true só se o aviso saiu: com --follow o canal
// é a notificação local (o Redmine fica de fora de propósito); sem --follow, o PUT tem que
// voltar 2xx. Falha de rede ou HTTP de erro = false, para o chamador tentar no próximo tick.
// Revisão independente (MAJOR-1, AGENTS.md regra 5): um PUT com resultado incerto
// (timeout, ECONNRESET, 5xx exceto 503) pode ter gravado a nota; repetir duplicaria o
// comentário (mesma razão de lib/redmine-fetch.js não repetir não-GET). Três desfechos:
// - sent (2xx) → notified_at;
// - failed (certeza de que não gravou: conexão recusada/sem DNS, 429, 503, 4xx) → tenta de
//   novo nos próximos ticks até NOTICE_MAX_ATTEMPTS, depois desiste com notice_failed_at;
// - uncertain → notice_uncertain_at; antes de reenviar, confere nos journals do ticket o
//   token único da nota; achou = dado; não achou = reenvia; não deu para conferir = espera.
// A notificação local sai uma vez por assinatura (local_notified_at).
const NOTICE_MAX_ATTEMPTS = 5;
const CERTAIN_NETWORK_FAILURES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

function noticeToken(signature) {
    return `[aviso-roteamento ${crypto.createHash('sha256').update(String(signature)).digest('hex').slice(0, 12)}]`;
}

async function putRoutingNote(ticketId, notes) {
    try {
        const res = await redmineFetch(`${REDMINE_URL}/issues/${ticketId}.json`, {
            method: 'PUT',
            headers: { 'X-Redmine-API-Key': REDMINE_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ issue: { notes } }),
        });
        if (res && res.ok) return 'sent';
        const status = res?.status;
        if (status === 503 || status === 429 || (status >= 400 && status < 500)) return 'failed';
        return 'uncertain';
    } catch (e) {
        const code = e?.code || e?.cause?.code;
        return CERTAIN_NETWORK_FAILURES.has(code) ? 'failed' : 'uncertain';
    }
}

// true = a nota com o token está no ticket; false = não está; null = não deu para conferir.
async function journalHasToken(ticketId, token) {
    try {
        const res = await redmineFetch(`${REDMINE_URL}/issues/${ticketId}.json?include=journals`, {
            headers: { 'X-Redmine-API-Key': REDMINE_API_KEY },
        });
        if (!res || !res.ok) return null;
        const body = await res.json();
        const journals = Array.isArray(body?.issue?.journals) ? body.issue.journals : null;
        if (!journals) return null;
        return journals.some(j => typeof j?.notes === 'string' && j.notes.includes(token));
    } catch {
        return null;
    }
}

/** Entrega o aviso conforme o estado do marcador; devolve o marcador atualizado (o chamador grava). */
async function deliverRoutingNotice(marker, { ticketId, msg, title, localBody }) {
    const now = new Date().toISOString();
    const m = { ...marker };
    if (!m.local_notified_at) {
        try {
            execFileSync('osascript', ['-e', `display notification ${JSON.stringify(localBody)} with title ${JSON.stringify(title)}`], { stdio: 'ignore' });
        } catch {
            // Não é macOS, ou sem permissão de notificação — não bloqueia o tick.
        }
        m.local_notified_at = now;
    }
    // --follow: o canal é a notificação local (Redmine fora de propósito, como notifyBlocked).
    if (FOLLOW) return { ...m, notified_at: now };
    if (m.notice_failed_at) return m;
    const token = noticeToken(m.signature);
    if (m.notice_uncertain_at) {
        const found = await journalHasToken(ticketId, token);
        if (found === true) return { ...m, notified_at: now, notice_uncertain_at: null };
        if (found === null) {
            console.warn(`Aviso de roteamento #${ticketId}: resultado anterior incerto e journals ilegíveis — não reenvio (sem duplicar); confiro no próximo tick.`);
            return m;
        }
    }
    m.notice_attempts = (m.notice_attempts || 0) + 1;
    const outcome = await putRoutingNote(ticketId, `${msg}\n\n${token}`);
    if (outcome === 'sent') return { ...m, notified_at: now, notice_uncertain_at: null };
    if (outcome === 'uncertain') {
        console.error(`Aviso de roteamento #${ticketId}: resultado incerto — confiro os journals antes de reenviar.`);
        return { ...m, notice_uncertain_at: now };
    }
    if (m.notice_attempts >= NOTICE_MAX_ATTEMPTS) {
        console.error(`Aviso de roteamento #${ticketId}: Redmine recusou ${m.notice_attempts} vezes — desisto (a recusa segue visível no Dashboard e no log).`);
        return { ...m, notice_failed_at: now };
    }
    console.error(`Aviso de roteamento #${ticketId}: Redmine recusou (tentativa ${m.notice_attempts}/${NOTICE_MAX_ATTEMPTS}) — tento de novo no próximo tick.`);
    return m;
}

// PRI-233 (PRI-205 S4, T7): resolução do §4.7 no início de cada Attempt de uma Run
// admitida com mode ON. Capacidades de produção: mecanismo de esforço UNAVAILABLE (U1), e
// o despacho roteado vai só com --model (SP-1 revista); a prova do plugin (SP-2,
// --settings próprio) roda em todo despacho roteado e é obrigatória. Provider: ACTIVE (um
// provider, sem dono de estado operacional: UNK-AR-005). Override humano: T8, de
// state.routing_overrides. Núcleo 2 (Jev): só registro, coletado antes (collectNucleus2, S3b).
function routingCapabilities(runDir, projectDir) {
    const effortMechanism = modelRouting.PRODUCTION_EFFORT_MECHANISM;
    // runDir null = pré-checagem sem worktree (ticket novo): só a avaliação de leitura
    // (conta, managed e settings do projeto em projectDir). Neutralizável → DEFERRED (a
    // gravação do --settings fica para depois do worktree); LOADED/UNKNOWN recusa já,
    // antes de qualquer branch/worktree (revisão independente, MAJOR-2). Com runDir, a
    // prova completa roda sempre: o despacho só por modelo também exige o plugin desligado.
    if (!runDir) {
        const ev = evaluatePluginProof({ accountDir: resolveClaudeAccount().dir, projectDir });
        return { effortMechanism, pluginProof: ev.status === 'NEUTRALIZABLE' ? { status: 'DEFERRED' } : { status: ev.status, reason: ev.reason } };
    }
    // projectDir = cwd do despacho (worktree do ticket): os settings do projeto também valem.
    return { effortMechanism, pluginProof: routedPluginProof({ accountDir: resolveClaudeAccount().dir, runDir, projectDir }) };
}

// state = state.json da task (null no ticket novo, que ainda não tem Run nem override).
// T8 (P-2): overrides humanas de state.routing_overrides, vigentes a partir do início da
// visita atual ao nó (D-4; routing-run.nodeVisitStart).
// `decomposed` (PRI-311, S5.2b, B5.3): Attempt com papel da Run decomposta — sinais só do grupo
// (`signalsKey`), `subtaskKey` para o override de subtarefa, piso da linhagem, rota fixa da
// integração e os papéis de subagente declarados (B8). Ausente = resolução da S4, sem mudança.
function resolveNodeRoute({ runSnapshot, node, ticket, worktreePath, isRecusaQA, runDir, state = null, stateReadAt = null, nucleus2 = null, decomposed = null }) {
    if (!runSnapshot.ok) {
        return { ok: false, result: 'NOT_STARTED', cause: 'CONFIG_UNVERIFIABLE', detail: runSnapshot.detail, decision: null };
    }
    let signals = node === modelRouting.ROUTED_NODE
        ? prospectiveSignalsForRun('claude', [node], { ticket, worktreePath, base: signalBaseBranch(ticket), isRecusaQA }).signals_prospective
        : undefined;
    if (decomposed && decomposed.signalsKey) signals = decompositionVisit.groupSignals(signals, decomposed.signalsKey);
    const overrides = Array.isArray(state?.routing_overrides) ? state.routing_overrides : [];
    // MINOR-1: o "agora" da visita nova é o instante da leitura do state (não o fim da
    // resolução), senão uma override gravada entre a leitura e aqui valeria no retry.
    const now = stateReadAt || new Date().toISOString();
    const boundary = state ? routingRun.nodeVisitStart(state, node, now) : null;
    const resolution = modelRouting.resolveRoute({
        snapshot: runSnapshot.snapshot, node, signals, provider: { state: 'ACTIVE' },
        capabilities: routingCapabilities(runDir, worktreePath), overrides, nodeBoundaryAt: boundary, nucleus2,
        ...(decomposed ? {
            subtaskKey: decomposed.subtaskKey ?? null, classFloor: decomposed.classFloor ?? null,
            fixedRoute: decomposed.fixedRoute === true, subagentRoles: decomposed.subagentRoles,
            subagentMechanism: decomposed.subagentMechanism ?? null,
        } : {}),
    });
    // Visita nova: o chamador grava o limite usado (state.routing_visit), para o retry da
    // mesma visita não usar o node_start, que é posterior (Bugbot, PR #97).
    return state ? { ...resolution, visit: routingRun.visitToRecord(state, node, boundary, now) } : resolution;
}

// PRI-205 S3b (T7): opiniões do Jev em SOMBRA para os grupos do Implement, antes da
// resolução. Só roda com o núcleo 2 efetivo no snapshot da Run e sob a reserva do
// ticket; nunca em --dry-run/simulação (nada externo). Nunca lança e nunca bloqueia: o
// resultado só entra como registro na RoutingDecision (classifier-shadow).
async function collectNucleus2({ runSnapshot, node, ticket, worktreePath, isRecusaQA, runDir, state, taskId }) {
    try {
        const signals = prospectiveSignalsForRun('claude', [node], { ticket, worktreePath, base: signalBaseBranch(ticket), isRecusaQA }).signals_prospective;
        const active = findActiveTask(ticket.id);
        const { planContent, specContent } = active && !active.corrupted ? readPlanArtifacts(ticket, active.dir) : { planContent: '', specContent: '' };
        const envelopes = planSignals.classifierEnvelopes(planContent, specContent);
        const groups = (signals && Array.isArray(signals.groups) ? signals.groups : []).map(g => {
            const e = envelopes.get(g.subtask_key);
            return e && e.ok ? { ...g, envelope: e.envelope } : { ...g, envelope: undefined, envelope_reason: e ? e.reason : 'ENVELOPE_MISSING' };
        });
        // Chave estável da visita (achado MAJOR 1 da revisão): não depende do instante do
        // tick, então um re-despacho antes do node_start não reenvia um pedido UNCERTAIN.
        return await classifierShadow.collectOpinions({
            runDir, root: REPO_PATH, snapshot: runSnapshot.snapshot, taskId, visit: routingRun.nucleus2VisitKey(state, node), groups,
        });
    } catch (e) {
        console.error(`[núcleo 2] #${ticket.id}: falha coletando opiniões (seguindo sem elas):`, e.message);
        return { status: 'OFF', reason: 'CLASSIFIER_COLLECTION_FAILED', opinions: [] };
    }
}

function routingRefusalNote(node, resolution) {
    return `Roteamento de modelo (mode ON) não iniciou o nó "${node}": NOT_STARTED / ${resolution.cause} ` +
        `(${resolution.detail}). Nenhum modelo foi herdado e nada foi despachado. ` +
        (resolution.detail === 'EFFORT_MECHANISM_UNAVAILABLE'
            ? 'O mecanismo para fixar o esforço no despacho ainda não foi verificado (U1); com mode ON nenhum despacho roteado inicia. '
            : '') +
        `Saída: desligar o roteamento (mode OFF) vale só para Runs novas; esta Run mantém o snapshot da admissão.`;
}

// Task existente: grava o Attempt NOT_STARTED, põe a Run em blocked (caminho humano
// existente) e avisa uma vez (notifyBlocked, assinatura nó:status). Nos ticks seguintes
// o status blocked impede novo Attempt.
async function refuseRoutedNode({ ticket, taskId, node, state, dir, resolution }) {
    dom06.beginAttempt(dir, {
        node, cause: dom06.causeFromState(state),
        admission: { status: 'NOT_STARTED', cause: resolution.cause, detail: resolution.detail },
        ...(resolution.decision ? { routing: resolution.decision } : {}),
    });
    const note = routingRefusalNote(node, resolution);
    const at = new Date().toISOString();
    // Mutação no próprio objeto lido: writeTaskState passa a base do CAS e não
    // sobrescreve o que outro escritor gravou no mesmo tick (MINOR-1).
    state.status = 'blocked';
    state.agent_log = [...(state.agent_log || []), { agent: 'watcher', nodes: [node], at, note }];
    writeTaskState(dir, state, 'routing_not_started');
    appendEvent(taskId, { type: 'checkpoint', node, agent: 'watcher', ts: at, detail: `routing NOT_STARTED: ${resolution.cause} (${resolution.detail})` }, dir);
    console.warn(`Task ${taskId}: ${note}`);
    // A Run acabou de entrar em blocked: um aviso de bloqueio anterior do mesmo nó (ex.:
    // retomada manual que não limpou o marcador) não pode calar este (MINOR-3). Os ticks
    // seguintes usam a mesma assinatura nó:blocked e não repetem.
    try { fs.rmSync(notifiedMarkerPath(dir), { force: true }); } catch { /* best-effort */ }
    await notifyBlocked(ticket, taskId, node, 'blocked', dir, state, note);
    return { action: 'skip', reason: 'routing_not_started', taskId, node, cause: resolution.cause, detail: resolution.detail };
}

// PRI-311 (S5.2a, H6): writer do `blocked` da Run decomposta, pelo mesmo caminho da recusa de
// roteamento da S4 (writeTaskState com CAS + notifyBlocked uma vez por assinatura). Marca o
// Attempt aplicado em decomposition_block_applied: o desbloqueio humano (unblocked) não é
// desfeito no tick seguinte. Nota só com códigos (motivo do aceite), nunca caminhos.
async function applyDecompositionBlock({ ticket, taskId, node, state, dir, pending }) {
    const at = new Date().toISOString();
    const note = `Run decomposta (PRI-287 S5): o Attempt ${pending.attempt_id} do nó "${pending.node}" não foi aceito ` +
        `(${pending.reason}). Retry automático só sem mutação observada no workspace; aqui há mutação possível ou o teto ` +
        `foi atingido, então a Run para no caminho humano. O diff parcial fica preservado no worktree (sem reset).`;
    state.status = 'blocked';
    state.decomposition_block_applied = { attempt_id: pending.attempt_id, reason: pending.reason, at };
    state.agent_log = [...(state.agent_log || []), { agent: 'watcher', nodes: [node], at, note }];
    writeTaskState(dir, state, 'decomposition_blocked');
    appendEvent(taskId, { type: 'checkpoint', node, agent: 'watcher', ts: at, detail: `decomposição: blocked (${pending.reason})` }, dir);
    console.warn(`Task ${taskId}: ${note}`);
    try { fs.rmSync(notifiedMarkerPath(dir), { force: true }); } catch { /* best-effort */ }
    await notifyBlocked(ticket, taskId, node, 'blocked', dir, state, note);
    return { action: 'skip', reason: 'decomposition_blocked', taskId, node, attempt: pending.attempt_id, cause: pending.reason };
}

// ---------------------------------------------------------------------------------
// Run decomposta (PRI-311 / PRI-287 S5.2b; SPEC B2, B5, B6, B8 e adendo H7). Atrás da flag:
// só uma Run cujo snapshot de admissão traz `decomposition: "on"` entra aqui, e a admissão
// real recusa "on" (DECOMPOSITION_RESERVED). Sem engine novo: o mesmo despacho do nó, com o
// Attempt criado por prepareRoleDispatch (baseline + cadeia + DOM-06) e o comando de passo.

const DECOMPOSED_GATES = new Set(['review', 'test', 'verify']);
// Attempt com papel STARTED, sem aceite e com a Run fora de `running` por mais que isto: o
// processo nunca subiu (exceção entre o Attempt e o lease) ou morreu sem lease. Fecha como
// órfão (H4: sem mutação → um retry; com mutação/UNKNOWN → blocked), nunca espera para sempre.
const DECOMPOSITION_ORPHAN_GRACE_MS = 2 * 60 * 1000;

// Versão da CLI do agente (B8): o mecanismo `--agents` só vale para a versão provada na tarefa 0.
let claudeCliVersionCache;
function claudeCliVersion() {
    if (claudeCliVersionCache !== undefined) return claudeCliVersionCache;
    try {
        const out = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 15000, env: cleanAgentEnv() });
        const m = /(\d+\.\d+\.\d+)/.exec(String(out.stdout || ''));
        claudeCliVersionCache = out.status === 0 && m ? m[1] : null;
    } catch {
        claudeCliVersionCache = null;
    }
    return claudeCliVersionCache;
}

function decompositionBlockPending(attemptId, reason, node) {
    return { attempt_id: attemptId || null, reason, node };
}

// B5.6: integração aceita e `execute_node` cumprida pela agregação → o watcher faz a
// transição implement → review pelo writer existente (CAS) e acrescenta `implement` ao
// history (o comando de integração não transiciona).
// CAS com expected_node (como o `state-writer transition` do /implement): o nó ainda é o
// implement e a versão é a lida no tick; conflito lança e nada é gravado.
function transitionDecomposedImplement({ taskId, state, dir, aggregate }) {
    const at = new Date().toISOString();
    const note = `Run decomposta: subtarefas e integração aceitas, agregação ${aggregate.duplicate ? 'já gravada' : 'gravada'} ` +
        `no Attempt ${aggregate.attempt_id}; transição implement → review feita pelo watcher.`;
    const written = stateWriter.update(dir, draft => {
        draft.node = 'review';
        draft.history = [...(draft.history || []), 'implement'];
        draft.updated_at = at;
        draft.agent_log = [...(draft.agent_log || []), { agent: 'watcher', nodes: ['implement'], at, note }];
    }, { operation: 'node_transition', actor: 'watcher', expect: { expected_state_version: cas.effectiveVersion(state), expected_node: 'implement' } });
    if (written) { Object.assign(state, written); rememberBase(written); checkWrittenState(dir); }
    appendEvent(taskId, { type: 'checkpoint', node: 'implement', agent: 'watcher', ts: at, detail: 'decomposição: implement → review (agregação)' }, dir);
    return { action: 'transitioned', taskId, node: 'implement', to: 'review', aggregate: aggregate.attempt_id };
}

/**
 * Prepara o despacho de um nó da Run decomposta. Devolve:
 * - `{ result }`: o tick termina aqui (em voo, blocked, transição);
 * - `{ decomposed: null }`: não decomponível ou nó fora do ramo → caminho da S4;
 * - `{ decomposed }`: ação, resolução, comandos, bloco de contexto e `admit()` (H0 + H6 +
 *   DOM-06), chamado pelo despacho depois dos portões.
 */
async function prepareDecomposedNode({ ticket, taskId, id, node, state, dir, worktreePath, base, isRecusaQA, stateReadAt, runSnapshot }) {
    const snapshot = runSnapshot.snapshot;
    const sections = modelRoutingPolicy.decompositionSections(snapshot.policy);
    const specHash = () => dom06SpecHash(state, worktreePath, id);
    const block = (attemptId, reason) => ({ result: applyDecompositionBlock({ ticket, taskId, node, state, dir, pending: decompositionBlockPending(attemptId, reason, node) }) });

    if (DECOMPOSED_GATES.has(node)) {
        const dec = state.decomposition;
        if (!dec || dec.status !== 'DECOMPOSABLE') return { decomposed: null };
        // Defesa da Review (B5.6, AC-22): sem agregação da versão vigente, não despacha.
        if (node === 'review' && !decompositionVisit.reviewAllowed(dir, dec.plan_version)) return block(null, 'REVIEW_WITHOUT_AGGREGATE');
        const resolution = resolveNodeRoute({ runSnapshot, node, ticket, worktreePath, isRecusaQA, runDir: dir, state, stateReadAt });
        return {
            decomposed: {
                action: { kind: 'gate' }, resolution, commands: null, contextBlock: null,
                admit: () => decompositionRuntime.prepareRoleDispatch({
                    runDir: dir, checkoutRoot: REPO_PATH, task: taskId, worktree: worktreePath,
                    decomposition: { role: 'gate', plan_version: dec.plan_version },
                    scopePaths: dec.scope_paths, watchGlobs: sections.workspace_watch_globs, limits: sections.manifest_limits, state,
                    dispatch: {
                        node, ticketId: id, baseBranch: base, specHash: specHash(), cause: dom06.causeFromState(state),
                        ...(resolution.ok ? { routing: snapshot, routingDecision: resolution.decision } : {}),
                    },
                }),
            },
        };
    }
    if (node !== 'implement') return { decomposed: null };

    // B2: decomposição da visita, gravada pelo writer existente.
    const { planContent } = readPlanArtifacts(ticket, dir);
    const rec = decompositionVisit.recordDecomposition(state, planContent);
    if (rec.changed) {
        state.decomposition = rec.decomposition;
        writeTaskState(dir, state, 'decomposition_recorded');
    }
    if (rec.refused) return block(null, rec.refused);
    const dec = state.decomposition;
    if (dec.status !== 'DECOMPOSABLE') {
        console.warn(`Task ${taskId}: plano não decomponível (${dec.cause}) — Implement segue como um Attempt (caminho da S4).`);
        return { decomposed: null };
    }
    // B5.7: volta de gate → rework mapeado (uma vez por gate).
    const rework = decompositionVisit.pendingRework({ runDir: dir, state, decomposition: dec });
    if (rework) {
        state.decomposition = { ...dec, rework };
        writeTaskState(dir, state, 'decomposition_rework');
    }
    const current = state.decomposition;
    // B5.8: scope_violation das subtarefas já fechadas (registro no Attempt, uma vez).
    for (const a of decompositionVisit.versionAttempts(dir, current.plan_version)) {
        if (a.role !== 'subtask' || !a.acceptance || a.scope_check) continue;
        try {
            const r = decompositionVisit.scopeCheck({ checkoutRoot: REPO_PATH, task: taskId, attempt: a, decomposition: current });
            dom06.recordScopeViolation(path.join(dir, 'dom06', 'attempts', `${a.attempt_id}.json`), r);
        } catch (e) {
            console.error(`Task ${taskId}: falha conferindo o escopo do Attempt ${a.attempt_id} (fica sem registro):`, e.message);
        }
    }

    let action = decompositionVisit.nextAction({ runDir: dir, state, decomposition: current });
    if (action.kind === 'wait' && state.status !== 'running') {
        const open = dom06.listAttempts(dir).find(a => a.attempt_id === action.attempt_id);
        if (open && Date.now() - Date.parse(open.created_at) > DECOMPOSITION_ORPHAN_GRACE_MS) {
            decompositionRuntime.closeRoleOrphan({ runDir: dir, node, task: taskId, checkoutRoot: REPO_PATH, orphanReason: 'agent_dead' });
            action = decompositionVisit.nextAction({ runDir: dir, state, decomposition: current });
        }
    }
    if (action.kind === 'wait') {
        return { result: { action: 'skip', reason: 'decomposition_attempt_open', taskId, node, attempt: action.attempt_id } };
    }
    if (action.kind === 'blocked') return block(action.attempt_id, action.reason);
    if (action.kind === 'rework_pending') return block(null, 'REWORK_NOT_RECORDED');
    if (action.kind === 'aggregate') {
        const agg = dom06.aggregateImplement(dir, current.plan_version, action.keys);
        if (!agg.ok) return block(null, 'AGGREGATE_PENDING');
        return { result: transitionDecomposedImplement({ taskId, state, dir, aggregate: agg }) };
    }

    // Subtarefa ou integração.
    const isSubtask = action.kind === 'subtask';
    const allKey = dom06.allKey(current.plan_version);
    const group = isSubtask ? decompositionVisit.keyGroup(current, action.key) : null;
    const agents = decompositionVisit.readProjectAgents(worktreePath);
    const mechanism = snapshot.policy && snapshot.policy.subagent_roles ? modelRouting.subagentMechanism(claudeCliVersion()) : null;
    const roles = modelRouting.subagentRoles({ snapshot, agents, mechanism });
    const resolution = resolveNodeRoute({
        runSnapshot, node, ticket, worktreePath, isRecusaQA, runDir: dir, state, stateReadAt,
        decomposed: isSubtask
            ? {
                signalsKey: action.key === allKey ? null : action.key,
                subtaskKey: action.key === allKey ? null : action.key, // ALL: só override de nó/ticket
                classFloor: decompositionVisit.classFloor({ runDir: dir, decomposition: current, key: action.key }),
                subagentRoles: roles.roles, subagentMechanism: mechanism,
            }
            : { fixedRoute: true, subagentRoles: roles.roles, subagentMechanism: mechanism },
    });
    if (resolution.ok) {
        resolution.agentsJson = roles.agentsJson;
        if (roles.agents_sha256) resolution.decision.subagent_agents_sha256 = roles.agents_sha256;
    }
    const dod = isSubtask ? decompositionVisit.deriveDod({ group, planContent }) : null;
    const ctx = isSubtask
        ? decompositionVisit.stepContextBlock({ taskId, group, planContent, dod, rework: action.rework })
        : decompositionVisit.integrationContextBlock({ taskId, decomposition: current });
    return {
        decomposed: {
            action, resolution, contextBlock: ctx.block,
            commands: [isSubtask ? `/implement-step ${taskId} ${action.key}` : `/implement-integrate ${taskId}`],
            admit: () => {
                const r = decompositionRuntime.prepareRoleDispatch({
                    runDir: dir, checkoutRoot: REPO_PATH, task: taskId, worktree: worktreePath,
                    decomposition: {
                        role: isSubtask ? 'subtask' : 'integration', plan_version: current.plan_version,
                        ...(isSubtask ? { subtask_key: action.key, steps: group.steps, rework: action.rework, dod } : {}),
                        parent_attempt_id: action.parent_attempt_id, context_record_sha256: ctx.sha256,
                    },
                    scopePaths: current.scope_paths, watchGlobs: sections.workspace_watch_globs, limits: sections.manifest_limits, state,
                    dispatch: {
                        node, ticketId: id, baseBranch: base, specHash: specHash(), cause: action.cause,
                        ...(resolution.ok ? { routing: snapshot, routingDecision: resolution.decision } : {}),
                    },
                });
                return r;
            },
        },
    };
}

// Ticket novo: o fetch_ticket recusado não cria Run nem worktree (Bugbot, PR #97: um
// worktree por ticket recusado esgotaria o pool). Sem Run não há Attempt: a recusa e a
// RoutingDecision ficam no marcador RUNS_DIR/<ticket>-routing-not-started.json, como a
// admissão recusada por config inválida. Um aviso por assinatura (causa|detalhe|snapshot),
// marcado como dado só depois de sair; falhou = o próximo tick tenta de novo.
function routingNotStartedMarkerPath(ticketId) {
    return `${RUNS_DIR}/${ticketId}-routing-not-started.json`;
}

async function refuseRoutedFetch({ ticket, resolution, snapshotSha }) {
    const markerPath = routingNotStartedMarkerPath(ticket.id);
    const signature = `${resolution.cause}|${resolution.detail}|${snapshotSha}`;
    const base = { action: 'skip', reason: 'routing_not_started', node: 'fetch_ticket', cause: resolution.cause, detail: resolution.detail };
    let marker = null;
    try { marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')); } catch { marker = null; }
    if (marker && marker.signature === signature && marker.notified_at) return base;
    if (!marker || marker.signature !== signature) {
        marker = {
            signature, node: 'fetch_ticket', result: 'NOT_STARTED', cause: resolution.cause, detail: resolution.detail,
            snapshot_sha256: snapshotSha, routing: resolution.decision || null,
            first_refused_at: new Date().toISOString(), notified_at: null,
        };
        fs.mkdirSync(RUNS_DIR, { recursive: true });
        fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2));
    }
    const note = routingRefusalNote('fetch_ticket', resolution);
    console.warn(`Ticket #${ticket.id}: ${note}`);
    const delivered = await deliverRoutingNotice(marker, {
        ticketId: ticket.id, msg: `[Watcher] Ticket #${ticket.id}: ${note}`,
        title: `Ticket #${ticket.id}: roteamento não iniciou`, localBody: `${resolution.cause} (${resolution.detail})`,
    });
    fs.writeFileSync(markerPath, JSON.stringify(delivered, null, 2));
    return base;
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
    // Spec ausente neste root e presente no checkout principal com o hash do Plan:
    // restaura (evento spec_restored) e segue. Hash diferente ou ausente nos dois
    // continua no portão, sem afrouxar. --dry-run não grava arquivo nem state.
    let restored = null;
    if (node !== 'plan' && specAuthority.GUARDED_NODES.has(node)) {
        const candidate = specArtifacts.restoreMatchingSpec({
            mainRoot: REPO_PATH, workRoot: root, state, taskId, dryRun: DRY_RUN,
        });
        if (DRY_RUN && candidate.wouldRestore) {
            console.log(`[dry-run] Task ${taskId}: restauraria ${candidate.specPath} do checkout principal (hash igual ao spec_hash do Plan).`);
            return {
                proceed: true,
                result: {
                    status: 'match', ok: true, specPath: candidate.specPath,
                    currentHash: candidate.hash, expectedHash: state.spec_hash,
                    reason: `spec ${candidate.specPath} ausente no worktree seria restaurada do checkout principal (mesmo spec_hash)`,
                },
            };
        }
        if (!DRY_RUN && candidate.restored) {
            restored = candidate;
            const at = new Date().toISOString();
            state.events = Array.isArray(state.events) ? state.events : [];
            state.events.push({
                type: 'spec_restored', node, ts: at, at,
                detail: `spec ${candidate.specPath} ausente no worktree restaurada do checkout principal (hash ${String(candidate.hash).slice(0, 12)} igual ao spec_hash do Plan)`,
            });
        }
    }
    // --dry-run não escreve nada: baseline tardio e aprovação manual gravam o changelog da
    // spec dentro do enforceSpecIntegrity, então ficam só no checkDrift; o resto roda numa cópia.
    const probe = DRY_RUN && node !== 'plan' ? specAuthority.checkDrift(state, { root, taskId }) : null;
    if (probe && (probe.status === 'no_baseline' || probe.status === 'approved')) {
        console.log(`[dry-run] Task ${taskId}: gravaria state.json (e o changelog da spec, se versionada): spec integrity — ${probe.reason}.`);
        return { proceed: true, result: probe };
    }
    const outcome = specAuthority.enforceSpecIntegrity(DRY_RUN ? structuredClone(state) : state, { root, taskId, node });
    if (outcome.changed || restored) {
        if (DRY_RUN) console.log(`[dry-run] Task ${taskId}: gravaria state.json: spec integrity — ${outcome.message}.`);
        else writeTaskState(dir, state);
        if (outcome.proceed) console.log(`Task ${taskId}: ${restored ? `spec restaurada do checkout principal (${restored.specPath}). ` : ''}${outcome.message}`);
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
        // PRI-180: nada de config/segredo de banco ou de aprovadores no ambiente do agente.
        if (/^PRISMA_(DB_|APPROVERS|PSQL)/.test(key) || /^PG(PASSWORD|PASSFILE|USER|HOST|SERVICE)/.test(key)) delete env[key];
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
const { looksUnavailable, looksLikeSessionLimit } = require('./lib/agent-exit-signals');

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
// PRI-311 (S5.2a, H1/O-03): Attempt com papel (Run decomposta) não fecha aqui. O release
// (claim + plan_version do mesmo snapshot) roda no exit do processo, como sempre; o aceite
// só é decidido depois do `drained`, com a saída completa (closeRoleAttempt). Devolve o
// contexto do release para esse fechamento adiado (null para Attempt sem papel).
function releaseLease(lease, code) {
    if (!lease) return null;
    try {
        let claim = null;
        let planVersion = null;
        if (lease.dir) {
            ({ reason: claim, plan_version: planVersion } = nodeLease.releaseNodeWithContext(lease));
            nodeEvents.recordNodeExit(lease, code);
        } else if (lease.runsDir) {
            const dir = nodeLease.stampNewTask(lease.runsDir, lease.prefix, lease);
            nodeLease.clearFetchDispatch(lease.gatePath, lease.startedAt);
            if (dir) nodeEvents.recordNodeExit(lease, code, dir);
        }
        if (lease.dom06Role) return { claim, planVersion };
        // PRI-310 (S5.1): mesma saída única do wrapper destacado (node-lease.js release).
        dom06.closeOnExit({
            attemptFile: lease.dom06AttemptFile,
            attemptId: lease.dom06AttemptId,
            node: lease.node || (Array.isArray(lease.nodes) ? lease.nodes[0] : null),
            code,
            claim,
        });
    } catch (e) {
        console.error('[recovery] falha liberando lease do nó:', e.message);
    }
    return null;
}

// PRI-311 (S5.2a, H1/H2): fechamento do Attempt com papel em --follow, depois do `drained`
// (output e stderr completos). Mesma saída única do wrapper destacado: exitContext (post no
// escopo do baseline, versão do release) + causa operacional, e closeOnExit.
// Falha no release (releaseCtx null) → claim desconhecido (não aceita, bloqueia); saída sem
// código (sinal, erro de spawn) → fechada como falha (C-O-02): Attempt com papel nunca fica
// STARTED sem acceptance depois de liberado o lease.
function closeRoleAttempt(lease, code, releaseCtx, output = '', stderr = '') {
    if (!lease || !lease.dom06Role) return null;
    const ctx = releaseCtx || { claim: 'CLAIM_UNKNOWN', planVersion: null };
    try {
        const { manifestPost, currentPlanVersion } = decompositionRuntime.exitContext({ lease, planVersion: ctx.planVersion });
        const operationalCause = require('./lib/agent-exit-signals').operationalCause({ code, output, stderr });
        return dom06.closeOnExit({
            attemptFile: lease.dom06AttemptFile,
            attemptId: lease.dom06AttemptId,
            node: lease.node || (Array.isArray(lease.nodes) ? lease.nodes[0] : null),
            code,
            claim: ctx.claim,
            manifestPost,
            currentPlanVersion,
            operationalCause,
            signalled: code === null || code === undefined,
        });
    } catch (e) {
        console.error('[recovery] falha fechando o Attempt com papel:', e.message);
        return null;
    }
}

function spawnAgent(bin, args, cwd, logPath, lease = null, extraEnv = {}) {
    const env = { ...cleanAgentEnv(), ...extraEnv };
    // Dono da execução (scripts/cas.js): a CLI scripts/state-writer.js usa como execution_id
    // esperado nas transições do agente — sessão assumida por outra (resume/replay) é recusada.
    if (lease?.executionId) env.STATE_EXECUTION_ID = lease.executionId;
    if (FOLLOW) {
        const logFile = fs.createWriteStream(logPath, { flags: 'a' });
        const logClosed = new Promise(resolve => logFile.once('close', resolve));
        let stdoutForFile, stderrForFile;
        logFile.on('error', error => {
            console.warn(`[log] falha gravando log do agente: ${sanitizeAgentOutput(error.message)}`);
            // O pipe se desconecta no erro do destino. Consome o restante para
            // não bloquear o agente; a falha do log não altera seu exit code.
            stdoutForFile?.resume();
            stderrForFile?.resume();
        });
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
        stdoutForFile = stdout.pipe(sanitizeLog.createLinePrefixStream('[claude]'));
        stderrForFile = stderr.pipe(sanitizeLog.createLinePrefixStream('[claude]'));
        stdoutForFile.pipe(logFile, { end: false });
        stderrForFile.pipe(logFile, { end: false });
        stdout.pipe(process.stdout);
        stderr.pipe(process.stderr);
        // O fim do readable só entrega os buffers ao writable. Espera também
        // o fechamento do arquivo (inclusive após erro) antes do appendFileSync
        // que registra a finalização do nó.
        const drained = Promise.all([stdoutForFile, stderrForFile].map(s => new Promise(resolve => {
            s.once('end', resolve);
            s.once('close', resolve);
            s.once('error', resolve);
        }))).then(async () => {
            if (!logFile.destroyed) logFile.end();
            await logClosed;
        });
        return new Promise(resolve => {
            let completed = false;
            const complete = code => {
                if (completed) return;
                completed = true;
                const releaseCtx = releaseLease(lease, code);
                drained.then(() => {
                    closeRoleAttempt(lease, code, releaseCtx, output, stderrBuffer);
                    resolve({ code, output, stderr: stderrBuffer });
                });
            };
            child.once('exit', complete);
            child.once('error', () => {
                // Spawn sem processo: não haverá saída a preservar. Fecha os
                // prefixadores e passa pelo mesmo fechamento do arquivo.
                stdoutForFile.destroy();
                stderrForFile.destroy();
                complete(null);
            });
        });
    }
    const logFd = fs.openSync(logPath, 'a');
    // PRI-311 (S5.2a, H2): Attempt com papel leva no lease o log do ticket e o tamanho dele
    // no spawn; o release destacado lê só daí em diante (texto de despacho anterior não conta).
    if (lease && lease.dom06Role) {
        lease.logPath = logPath;
        try { lease.logOffset = fs.fstatSync(logFd).size; } catch { lease.logOffset = null; }
    }
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

function startCostRun(ticketId, { agent, nodes, sessionId, admissionDecision = null, signalContext = null, routing = null }) {
    if (DRY_RUN) return null;
    try {
        const selected = agent === 'claude' ? resolveClaudeAccount() : null;
        const metadata = selected ? accountCostMetadata(selected)
            : { account: { source: 'UNKNOWN', label: 'UNKNOWN' }, effort_router_plugin: 'UNKNOWN' };
        const run = { session_id: sessionId, agent, nodes, started_at_ms: Date.now(), pid: null,
            ...costTracking.admissionForCost(admissionDecision, ticketId, taskRunsDir(ticketId)), ...metadata,
            pricing_snapshot: costTracking.pricingSnapshot(),
            ...(selected?.dir ? { claude_config_dir: selected.dir } : {}),
            ...prospectiveSignalsForRun(agent, nodes, signalContext),
            ...(routing?.ok ? { routing_decision: routing.decision } : {}) };
        const ledger = readCostLedger(ticketId);
        ledger.pending.push(run);
        writeCostLedger(ticketId, ledger);
        return run;
    } catch (e) {
        console.error(`[custo] #${ticketId}: falha registrando início do despacho (seguindo sem métrica):`, e.message);
        return null;
    }
}

// ---------------------------------------------------------------------------------
// Sinais prospectivos e retrospectivos do Implement (PRI-222 / PRI-205 S2).
// SÓ OBSERVACIONAL: gravados no registro de Attempt da S1 (cost_tracking.nodes.implement
// .attempts[].signals); nada aqui classifica, roteia ou altera o despacho. Coleta
// best-effort: qualquer falha vira UNKNOWN com causa e o nó/despacho segue igual.
function prospectiveSignalsForRun(agent, nodes, signalContext) {
    if (agent !== 'claude' || nodes[nodes.length - 1] !== 'implement') return {};
    const out = { signals_prospective: { status: 'UNKNOWN', cause: 'COLLECTION_FAILED', groups: [] } };
    if (!signalContext?.ticket || !signalContext.worktreePath) {
        out.signals_prospective.cause = 'NO_SIGNAL_CONTEXT';
        return out;
    }
    const { ticket, worktreePath, base = null, isRecusaQA = false } = signalContext;
    // Só o diretório local de trabalho, para o fim do despacho; nunca vai para o Attempt.
    out.signal_ctx = { worktree_path: worktreePath, base };
    try {
        const active = findActiveTask(ticket.id);
        if (!active || active.corrupted) { out.signals_prospective.cause = 'NO_ACTIVE_TASK'; return out; }
        const { planContent, specContent } = readPlanArtifacts(ticket, active.dir);
        const root = path.resolve(worktreePath);
        out.signals_prospective = planSignals.buildProspective(planContent, {
            specContent, state: active.state, costTracking: active.state?.cost_tracking, isRecusaQA,
            fileExists: rel => {
                const abs = path.resolve(root, rel);
                if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('caminho fora do worktree');
                return fs.existsSync(abs);
            },
        });
    } catch (e) {
        out.signals_prospective = { status: 'UNKNOWN', cause: 'COLLECTION_FAILED', groups: [] };
        console.error(`[sinais] #${ticket.id}: falha nos sinais prospectivos (seguindo sem eles):`, e.message);
    }
    return out;
}

// Base do diff dos sinais; avaliada com guarda para nunca lançar fora da coleta best-effort.
function signalBaseBranch(ticket) {
    try { return BASE_BY_LIBERACAO[branchLiberacao(ticket)] ?? null; } catch { return null; }
}

// Estatística de linhas do diff do ticket (tracked desde o merge-base + untracked).
// Qualquer leitura impossível => null (UNKNOWN); nunca subconta em silêncio.
// git para os sinais: saída NUL-delimitada, sem aspas/escape octal em nomes com acento ou
// espaço (core.quotepath=false + -z) e com timeout, para não travar o fechamento do run.
function gitZ(cwd, args) {
    return execFileSync('git', ['-c', 'core.quotepath=false', ...args],
        { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: 30000 })
        .split('\0').filter(Boolean);
}

function collectDiffStat(worktreePath, mergeBase) {
    let added = 0, removed = 0;
    // --no-renames: renomeação vira remoção + adição, sem "old => new" no caminho.
    // Com -z cada registro é "<add>\t<rem>\t<caminho>".
    for (const record of gitZ(worktreePath, ['diff', '--numstat', '-z', '--no-renames', mergeBase])) {
        const [a, r, ...rest] = record.split('\t');
        if (planSignals.isFlowArtifact(rest.join('\t'))) continue;
        if (a === '-' || r === '-') return null; // binário: sem contagem de linhas
        if (!/^\d+$/.test(a) || !/^\d+$/.test(r)) return null; // formato inesperado: UNKNOWN
        added += Number(a); removed += Number(r);
    }
    for (const f of gitZ(worktreePath, ['ls-files', '--others', '--exclude-standard', '-z'])) {
        if (planSignals.isFlowArtifact(f)) continue;
        const abs = path.join(worktreePath, f);
        const st = fs.statSync(abs);
        if (!st.isFile() || st.size > 2 * 1024 * 1024) return null;
        const text = fs.readFileSync(abs, 'utf8');
        if (text.includes('\0')) return null;
        added += text === '' ? 0 : text.replace(/\n$/, '').split('\n').length;
    }
    return { added, removed };
}

function collectRetrospectiveSignals(run, target) {
    const ctx = run.signal_ctx;
    if (!ctx?.worktree_path) return { status: 'UNKNOWN', cause: 'NO_SIGNAL_CONTEXT' };
    const parts = { changedFiles: null, diffStat: null, affected: null, schema: null,
        declaredPaths: planSignals.declaredUnion(run.signals_prospective), state: null };
    try { parts.state = target ? readStateJson(target.dir) : null; } catch { /* sem state */ }
    let mergeBase = null;
    try { mergeBase = findMergeBase(ctx.worktree_path, ctx.base); } catch { /* UNKNOWN */ }
    if (!mergeBase) return planSignals.retrospectiveSignals(parts);
    try {
        parts.changedFiles = [...new Set([
            ...gitZ(ctx.worktree_path, ['diff', '--name-only', '-z', '--no-renames', mergeBase]),
            ...gitZ(ctx.worktree_path, ['ls-files', '--others', '--exclude-standard', '-z']),
        ])];
    } catch { /* UNKNOWN */ }
    if (parts.changedFiles) {
        try { parts.affected = serviceDetector.analyzeChangedFiles(parts.changedFiles); } catch { /* UNKNOWN */ }
        try {
            const r = schemaWatcher.detectSchemaChanges(parts.changedFiles, collectSchemaDiff(ctx.worktree_path, ctx.base, parts.changedFiles));
            parts.schema = { detected: r.detected, riskLevel: r.riskLevel ?? null };
        } catch { /* UNKNOWN */ }
    }
    try { parts.diffStat = collectDiffStat(ctx.worktree_path, mergeBase); } catch { /* UNKNOWN */ }
    return planSignals.retrospectiveSignals(parts);
}

// Valor final de attempts[].signals para o run que acabou de fechar. Nunca lança.
function attemptSignalsForRun(run, target) {
    if (!run.signals_prospective) return undefined; // nó sem sinais (não-implement): 'UNAVAILABLE' no registro
    try {
        return { ...run.signals_prospective, retrospective: collectRetrospectiveSignals(run, target) };
    } catch (e) {
        console.error('[sinais] falha nos sinais retrospectivos (seguindo sem eles):', e.message);
        return { ...run.signals_prospective, retrospective: { status: 'UNKNOWN', cause: 'COLLECTION_FAILED' } };
    }
}

// PRI-223 S3: decisão sombra would_route a partir dos sinais S2. Best-effort; falha
// não altera despacho. cheap_rule → R1–R8 (default da policy sombra); off → NO_DECISION.
// Nunca aplica --model / esforço (S4 fora de escopo).
function attemptWouldRouteForRun(signals) {
    if (!signals || signals === 'UNAVAILABLE') return 'UNAVAILABLE';
    try {
        return wouldRoute.shadowDecide({ signals });
    } catch (e) {
        console.error('[would_route] falha na decisão sombra (seguindo sem ela):', e.message);
        return {
            status: 'NO_DECISION',
            cause: 'COLLECTION_FAILED',
            detail: e.message,
            decisions: [],
            applied: false,
        };
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
        const usage = costTracking.sumClaudeUsage(files.map(f => ({
            role: f.includes(`${path.sep}subagents${path.sep}`) ? 'subagent' : 'main',
            file_ref: f.includes(`${path.sep}subagents${path.sep}`) ? path.basename(f) : 'main',
            content: fs.readFileSync(f, 'utf8'),
        })), run.pricing_snapshot);
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
    for (const field of ['usage', 'unpriced_models', 'read_order', 'dedup_conflicts', 'role_attribution', 'first_turn', 'cost_estimated', 'pricing_sha256', 'pricing_source']) {
        if (tokens[field] !== undefined) metrics[field] = tokens[field];
    }
    return { node, metrics };
}

// Fecha um run pendente: mede, acumula no cost_tracking da task e grava no state.json.
// Nunca toca state.updated_at — ele decide findActiveTask e o "já tratado neste ciclo"
// de mostRecentArchivedCommit; métrica não pode mexer nisso.
// PRI-311 (S5.2b, B8): `observed_model` por papel depois da saída, pela trilha de uso da S1
// (subagents/*.jsonl casados com o papel pelo subagent_type). Só Attempt com papel e com
// subagent_roles declarados; falha aqui nunca muda o despacho nem o aceite.
function recordSubagentObservation(run, attempt, attemptFile) {
    try {
        if (!attempt.role || run.agent !== 'claude') return;
        const declared = attempt.routing && Array.isArray(attempt.routing.subagent_roles) ? attempt.routing.subagent_roles : null;
        if (!declared) return;
        const attribution = decompositionVisit.attributionFromTranscripts(findRunTranscripts(run));
        dom06.recordSubagentObservation(attemptFile, modelRouting.observeSubagentRoles(declared, attribution));
    } catch (e) {
        console.error(`[custo] falha observando subagentes do Attempt ${attempt.attempt_id}:`, e.message);
    }
}

function finishCostRun(ticketId, sessionId, endMs = null, outcome = {}) {
    if (DRY_RUN) return;
    try {
        const ledger = readCostLedger(ticketId);
        const idx = ledger.pending.findIndex(r => r.session_id === sessionId);
        if (idx === -1) return;
        const run = ledger.pending[idx];
        const target = findCostTargetTask(ticketId, run.nodes[run.nodes.length - 1]);
        const { node, metrics } = collectRunMetrics(run, target, endMs);
        // Só leitura do arquivo admitido; nunca deriva identidade do lease ou latest.
        let attemptResult = 'UNKNOWN';
        const ref = run.admission?.attempt_ref;
        if (ref && typeof ref === 'object' && typeof ref.path === 'string' &&
            !path.isAbsolute(ref.path) && !ref.path.startsWith('..') &&
            ref.runs_root === `worktree:${ticketId}/memory/runs`) {
            try {
                const attemptFile = path.join(taskRunsDir(ticketId), ref.path);
                const attempt = JSON.parse(fs.readFileSync(attemptFile, 'utf8'));
                if (attempt.attempt_id === run.admission.attempt_id) {
                    attemptResult = attempt.result || 'UNKNOWN';
                    recordSubagentObservation(run, attempt, attemptFile);
                }
            } catch { /* arquivo não observável (ex.: arquivamento): UNKNOWN */ }
        }
        const observedOutcome = { ...outcome, attemptResult };
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
        const signals = attemptSignalsForRun(run, target);
        const updated = costTracking.mergeRun(current, {
            node, agent: run.agent, alsoCovers: run.nodes.slice(0, -1), metrics,
            run: { ...run, signals, would_route: attemptWouldRouteForRun(signals) }, outcome: observedOutcome,
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

function attachDom06Lease(lease, decision, node, { task = null } = {}) {
    if (!lease || !decision?.attempt || node === 'commit') return lease;
    lease.dom06AttemptFile = decision.attemptFile;
    lease.dom06AttemptId = decision.attempt.attempt_id;
    if (!lease.node) lease.node = node;
    // PRI-311 (S5.2a, H1): Attempt com papel. As adições do DOM-06 ao lease são só o papel, o
    // diretório de manifestos e a task: nunca a chave nem o escopo.
    if (decision.attempt.role) {
        lease.dom06Role = decision.attempt.role;
        lease.dom06ManifestsDir = decompositionRuntime.manifestPaths(REPO_PATH).manifestsDir;
        lease.task = task || path.basename(lease.dir || '');
    }
    return lease;
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
async function dispatchClaudeSegment({ ticket, isRecusaQA, qaFeedback, worktreePath, commands, nodes, extraNote, contextBlock = '', lease = null, extraEnv = {}, admissionDecision = null, routing = null }) {
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
    // PRI-233 T7: só com resolução ok (Run ON); sem routing o argv é o do AS-IS.
    // PRI-311 (S5.2b, B8): `--agents` só em Attempt com papel e com subagent_roles na policy.
    if (routing) args.push(...modelRouting.routedArgs([], routing, { agentsJson: routing.agentsJson || null }));
    if (SIMULATE) return simulateClaudeSegment({ ticket, nodes, lease, extraNote });
    console.log(`Despachando Claude (${commands.join(', ')}) para #${ticket.id} em ${worktreePath}`);
    const costRun = startCostRun(ticket.id, {
        agent: 'claude', nodes, sessionId, admissionDecision, routing,
        signalContext: { ticket, worktreePath, isRecusaQA, base: signalBaseBranch(ticket) },
    });
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
    const releaseCtx = releaseLease(lease, result.code);
    closeRoleAttempt(lease, result.code, releaseCtx, result.output || '', result.stderr || '');
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

// Ponto comum de despacho do watcher (tick) e do dashboard (node-dispatcher.dispatchNode):
// tudo roda sob a reserva do ticket (scripts/lib/dispatch-reservation.js), da leitura
// de state.json/marcador até o despacho ficar visível em disco. Quem chega com a
// reserva tomada pula, sem ler nada. --dry-run não grava nada, nem a reserva.
async function dispatchTicket(ticket) {
    if (DRY_RUN) return dispatchTicketReserved(ticket);
    const reservation = dispatchReservation.reserve({ repoPath: REPO_PATH, ticketId: ticket.id });
    if (!reservation.acquired) {
        console.log(`[reserva] ${reservation.message} — não despacho.`);
        return { action: 'skip', reason: 'despacho_reservado', holderPid: reservation.holder?.pid ?? null };
    }
    if (reservation.takeover) console.warn(`[reserva] ticket #${ticket.id}: reserva de despachante morto retomada (${watcherLock.describeHolder(reservation.previous)}).`);
    try {
        return await dispatchTicketReserved(ticket);
    } finally {
        reservation.release();
    }
}

// Despacho do fetch_ticket+plan que não chegou ao spawn (admissão recusada, erro antes
// do agente): o marcador sai na hora — senão o dashboard mostraria "rodando
// fetch_ticket" e recusaria o ▶ Disparar até o prazo. Com agent_pid o agente existe e
// o marcador fica (sai no release do lease).
function dropUnspawnedFetchDispatch(id, lease) {
    const d = readSpecGate(id)?.fetch_dispatch;
    if (d && d.started_at === lease.startedAt && !d.agent_pid) nodeLease.clearFetchDispatch(lease.gatePath, lease.startedAt);
}

async function dispatchTicketReserved(ticket) {
    // PRI-233 (revisão independente, MINOR-1): instante da leitura do state neste tick. É o
    // limite D-4 do 1º Attempt de uma visita: override gravada depois dele (no meio da
    // resolução) não entra neste Attempt e também não pode entrar no retry da mesma visita.
    const stateReadAt = new Date().toISOString();
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

    // Agente do fetch_ticket+plan ainda vivo (gate.fetch_dispatch): ele cria o state.json
    // no meio do segmento e segue no /plan com a task em in_progress. Despachar aqui —
    // task nova ou o nó do state.json recém-criado — seria um segundo agente no ticket.
    const liveFetch = nodeLease.fetchDispatchLive(readSpecGate(id));
    if (liveFetch) {
        console.log(`Ticket #${id}: fetch_ticket+plan em execução desde ${liveFetch.started_at}${liveFetch.agent_pid ? ` (pid ${liveFetch.agent_pid})` : ''} — não redespacho.`);
        return { action: 'skip', reason: 'fetch_em_execucao', taskId: active?.taskId ?? null, agentPid: liveFetch.agent_pid ?? null, since: liveFetch.started_at };
    }

    // O dashboard já pode ter marcado implement/in_progress antes de o watcher
    // consumir o sinal. Um retry pendente não pode contornar a falha de preparação
    // pelo despacho normal (inclui sinal ainda no _archive ou destino ocupado).
    for (const root of ticketRunRoots(id)) {
        for (const taskId of listTaskDirs(root, id)) {
            if (fs.existsSync(path.join(root, taskId, QA_RETRY_SIGNAL))) {
                return { action: 'skip', reason: 'qa_retry_pendente', taskId };
            }
        }
    }

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

        // PRI-233 (PRI-205 S4): admissão da Run com roteamento. Ausente/OFF = AS-IS (sem
        // snapshot). ON válido fixa o snapshot routing no Attempt fetch_ticket. ON inválido
        // (ou mode malformado) recusa a admissão antes de worktree, marcador ou Attempt:
        // nenhuma Run é criada (RC-5/D12 b, DP-3).
        const routingConfig = modelRoutingPolicy.readRoutingConfig(REPO_PATH);
        if (routingConfig.status === 'INVALID') {
            console.warn(`Ticket #${id}: roteamento ON com configuração inválida (${routingConfig.cause}: ${routingConfig.detail}) — admissão recusada, nenhuma Run criada.`);
            if (!DRY_RUN) await notifyRoutingAdmissionBlocked(ticket, routingConfig);
            return {
                action: 'skip', reason: 'routing_admission_blocked', node: 'fetch_ticket',
                cause: routingConfig.cause, detail: routingConfig.detail, transient: routingConfig.transient,
            };
        }
        if (!DRY_RUN) clearRoutingBlockedMarker();
        // PRI-205 S3b (T5): núcleo 2 efetivo decidido aqui e fixado no snapshot. Nunca
        // bloqueia a admissão: sem Authority Ref (hoje) fica off com o motivo.
        // Seleção do classificador (B11): registro próprio do consumidor; sem registro,
        // vale a policy. Registro ilegível = núcleo 2 off, sem bloquear.
        const classifierSel = routingConfig.status === 'ON'
            ? classifierSelection.effectiveClassifier(REPO_PATH, routingConfig.policy)
            : null;
        if (classifierSel && classifierSel.source === 'INVALID') {
            console.warn(`Ticket #${id}: registro de seleção do classificador ilegível — núcleo 2 off nesta Run (${classifierSel.reason}).`);
        }
        const classifierEffective = classifierSel
            ? classifierAuthority.evaluateClassifier({
                classifier: classifierSel.classifier, classifierConfig: routingConfig.classifier_config,
                root: REPO_PATH, project: path.basename(REPO_PATH),
            })
            : null;
        if (classifierEffective && classifierEffective.provider === 'off') {
            console.warn(`Ticket #${id}: núcleo 2 (jev) declarado na policy, efetivo off nesta Run (${classifierEffective.reason}${classifierEffective.detail ? `: ${classifierEffective.detail}` : ''}).`);
        }
        const routingSnapshot = routingConfig.status === 'ON' ? modelRouting.buildRoutingSnapshot(routingConfig, { classifierEffective, classifierSelection: classifierSel }) : undefined;

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

        // PRI-233 (Bugbot, PR #97; revisão independente MAJOR-2): pré-checagem do
        // roteamento ANTES de qualquer branch ou worktree, com a avaliação de leitura do
        // plugin (conta, managed e settings do REPO_PATH). Toda recusa sai aqui, sem tocar no
        // git; só a gravação/conferência do --settings fica para depois do worktree.
        if (routingSnapshot) {
            const pre = resolveNodeRoute({
                runSnapshot: { ok: true, snapshot: routingSnapshot }, node: 'fetch_ticket', ticket,
                worktreePath: REPO_PATH, isRecusaQA, runDir: null,
            });
            // DEFERRED = plugin neutralizável, só falta gravar o --settings (depois do worktree).
            const deferredProofOnly = pre.detail === 'PLUGIN_NOT_PROVEN_OFF' && pre.decision?.effort_router_plugin === 'DEFERRED';
            if (!pre.ok && !deferredProofOnly) {
                return refuseRoutedFetch({ ticket, resolution: pre, snapshotSha: routingSnapshot.sha256 });
            }
        } else {
            try { fs.rmSync(routingNotStartedMarkerPath(id), { force: true }); } catch { /* best-effort */ }
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

        // PRI-233 (PRI-205 S4, T7): com mode ON, o segmento fetch_ticket+plan (nós fixos,
        // D6) é resolvido por inteiro (com a prova do plugin) antes do marcador/lease.
        // Depois da pré-checagem só resta gravar/conferir o --settings no worktree (e
        // reavaliar os settings dele); recusa = NOT_STARTED sem Run.
        let fetchRouting = null;
        if (routingSnapshot) {
            const fetchRunDir = path.join(taskRunsDir(id), '_dom06');
            fs.mkdirSync(fetchRunDir, { recursive: true });
            fetchRouting = resolveNodeRoute({
                runSnapshot: { ok: true, snapshot: routingSnapshot }, node: 'fetch_ticket', ticket, worktreePath, isRecusaQA,
                runDir: fetchRunDir,
            });
            if (!fetchRouting.ok) {
                return refuseRoutedFetch({ ticket, resolution: fetchRouting, snapshotSha: routingSnapshot.sha256 });
            }
            try { fs.rmSync(routingNotStartedMarkerPath(id), { force: true }); } catch { /* best-effort */ }
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
        // Sem marcador visível o próximo despachante pode passar pelo check-then-act
        // enquanto este ainda sobe o agente (PRI-218 A-01 / concurrency-map). Falha na
        // gravação do fetch_dispatch = falha fechada: não spawna.
        try {
            writeSpecGate(id, {
                ...(readSpecGate(id) || { ticket_id: id }),
                subject: ticket.subject,
                fetch_dispatch: { started_at: newTaskLease.startedAt, timeout_ms: NODE_TIMEOUT_MS, dispatch_id: crypto.randomUUID() },
            });
        } catch (e) {
            console.error(`Ticket #${id}: falha gravando marcador de despacho no gate file — abortando spawn:`, e.message);
            throw e;
        }
        let fetchAdmission;
        try {
            fetchAdmission = dom06.prepareDispatch({
                runDir: path.join(taskRunsDir(id), '_dom06'),
                node: 'fetch_ticket',
                ticketId: id,
                baseBranch: base,
                specHash: null,
                cause: 'dispatch',
                ...(routingSnapshot ? { routing: routingSnapshot, routingDecision: fetchRouting.decision } : {}),
            });
        } catch (e) {
            dropUnspawnedFetchDispatch(id, newTaskLease);
            throw e;
        }
        if (!fetchAdmission.dispatch) {
            dropUnspawnedFetchDispatch(id, newTaskLease);
            console.warn(`Ticket #${id}: admissão DOM06 ${fetchAdmission.attempt.result} — fetch_ticket não despachado e não conta como PASS.`);
            return { action: 'skip', reason: `dom06_${String(fetchAdmission.attempt.result).toLowerCase()}`, node: 'fetch_ticket' };
        }
        // PRI-233 (MAJOR-1): ponteiro determinístico da admissão para a task que o agente
        // vai criar. OFF apaga o ponteiro de um ciclo ON anterior (no-op sem ponteiro).
        try {
            const fetchRunDir = path.join(taskRunsDir(id), '_dom06');
            if (routingSnapshot) routingRun.recordAdmission(fetchRunDir, fetchAdmission.attempt);
            else routingRun.clearAdmission(fetchRunDir);
        } catch (e) {
            dropUnspawnedFetchDispatch(id, newTaskLease);
            throw e;
        }
        attachDom06Lease(newTaskLease, fetchAdmission, 'fetch_ticket');
        beginCycle({ ticketId: id, node: 'fetch_ticket' });
        logRun(id, '[watcher]', 'iniciando nós: fetch_ticket, plan');
        let fetchResult = null;
        try {
        fetchResult = await dispatchClaudeSegment({
            ticket, isRecusaQA, qaFeedback, worktreePath, lease: newTaskLease,
            extraEnv: dom06AttemptEnv(fetchAdmission), admissionDecision: fetchAdmission, routing: fetchRouting,
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
        } catch (e) {
            dropUnspawnedFetchDispatch(id, newTaskLease);
            throw e;
        } finally {
            endCycle(cycleOutcome(fetchResult));
        }
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
    // authorization-pending: pedido estruturado de ação privilegiada (scripts/lib/authorization.js).
    // Não redespacha, não interpreta mensagem livre (não está em HUMAN_INPUT_RESUMABLE_STATUSES)
    // e comenta no Redmine uma vez; a decisão é só pelos endpoints do dashboard. Antes dos
    // portões: nenhum deles mexe num run que espera decisão humana sobre efeito externo.
    if (status === authorization.STATUS) {
        const p = state.pending_authorization;
        console.warn(`Task ${taskId}: aguardando autorização humana ${p?.id || '?'} (${p?.kind || '?'}, fase ${p?.phase || '?'}) — não despacho.`);
        if (!DRY_RUN) {
            const note = p
                ? `Pedido de autorização ${p.id} (${p.kind}): ${p.summary}\nAlvo sugerido: ${p.target_hint?.alias || '—'} (o banco é escolhido por quem aprova). Artefato: ${p.artifact} (sha256 ${String(p.artifact_sha256 || '').slice(0, 12)}…). Esperado depois: ${p.expected}.`
                : null;
            await notifyBlocked(ticket, taskId, node, status, dir, state, note);
        }
        return { action: 'skip', reason: 'status_authorization_pending', taskId, node, authorization: p?.id || null };
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
    // PRI-311 (S5.2a, H6): `blocked` a partir do acceptance gravado por um Attempt com papel
    // (no modo destacado, o wrapper só grava o Attempt; o bloqueio vem neste tick). Só com a
    // Run em in_progress e uma vez por Attempt; nunca sobrescreve session_limit nem status
    // gravado pelo comando.
    if (!DRY_RUN && status === 'in_progress') {
        const pending = decompositionRuntime.pendingBlock(dir, state);
        if (pending) return applyDecompositionBlock({ ticket, taskId, node, state, dir, pending });
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
    if (status === 'handed_back_qa') {
        console.warn(`Task ${taskId}: status "handed_back_qa" mas ainda em memory/runs/ (não arquivada) — a devolução ao QA não terminou o arquivamento.`);
        return { action: 'skip', reason: 'handback_nao_arquivada', taskId };
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

    // PRI-233 (PRI-205 S4): roteamento ANTES dos portões com efeito (pré-build, churn,
    // consumo de human-input), para que uma recusa não os execute nem sobrescreva o que
    // eles gravaram (revisão do Checkpoint B, MINOR-1).
    // Ligação: ponteiro da admissão (MAJOR-1). Run admitida OFF não ganha campo nenhum;
    // rastro de ON que não dá para ligar recusa. Run ON resolve o §4.7 antes do Attempt.
    let nodeRouting = null;
    let nodeRoutingSnapshot = null;
    // PRI-311 (S5.2b): ramo da Run decomposta (snapshot com decomposition "on"; atrás da flag).
    let decomposed = null;
    {
        const fetchRunDir = path.join(taskRunsDir(id), '_dom06');
        const binding = routingRun.bindingFor(state, fetchRunDir, taskId);
        if (binding.action === 'refuse') {
            return refuseRoutedNode({ ticket, taskId, node, state, dir,
                resolution: { ok: false, result: 'NOT_STARTED', cause: 'CONFIG_UNVERIFIABLE', detail: binding.detail, decision: null } });
        }
        if (binding.action === 'bind') {
            state.routing_snapshot = binding.binding;
            writeTaskState(dir, state, 'routing_snapshot_bind');
            routingRun.markConsumed(fetchRunDir, taskId);
        }
        const runSnapshot = routingRun.loadRunSnapshot(state, fetchRunDir);
        if (runSnapshot.mode === 'ON') {
            if (runSnapshot.ok && decompositionVisit.isDecomposedSnapshot(runSnapshot.snapshot) && (node === 'implement' || DECOMPOSED_GATES.has(node))) {
                const prep = await prepareDecomposedNode({ ticket, taskId, id, node, state, dir, worktreePath, base, isRecusaQA, stateReadAt, runSnapshot });
                if (prep.result) return prep.result;
                decomposed = prep.decomposed;
            }
            // Núcleo 2 (só registro) não é coletado por subtarefa: a visita da Run decomposta
            // segue sem opinião do Jev (declarado na evidência da S5.2b).
            const nucleus2 = !decomposed && node === modelRouting.ROUTED_NODE && !DRY_RUN && !SIMULATE
                && runSnapshot.snapshot?.classifier_effective?.provider === 'jev'
                ? await collectNucleus2({ runSnapshot, node, ticket, worktreePath, isRecusaQA, runDir: dir, state, taskId })
                : null;
            nodeRouting = decomposed ? decomposed.resolution : resolveNodeRoute({ runSnapshot, node, ticket, worktreePath, isRecusaQA, runDir: dir, state, stateReadAt, nucleus2 });
            if (nodeRouting.visit) state.routing_visit = nodeRouting.visit;
            if (!nodeRouting.ok) return refuseRoutedNode({ ticket, taskId, node, state, dir, resolution: nodeRouting });
            if (nodeRouting.visit) writeTaskState(dir, state, 'routing_visit');
            nodeRoutingSnapshot = runSnapshot.snapshot;
        }
    }

    // Portão de build entre plan e implement — ver runPreBuildGate. Antes do lease:
    // o Maven roda aqui no watcher, não é o agente que está "running".
    let preBuildNote = '';
    // PRI-311 (S5.2b, B5.1/AC-23): na Run decomposta, pré-build uma vez, antes da primeira
    // subtarefa (não antes da integração nem de cada passo).
    const preBuildDue = decomposed
        ? decomposed.action.kind === 'subtask' && needsPreBuildGate(state) && decompositionVisit.preBuildDue(dir)
        : needsPreBuildGate(state);
    if (preBuildDue) {
        // DRY-RUN: mesmo portão, com `mvn compile` simulado (sucesso) no lugar do Maven.
        const gate = await runPreBuildGate(ticket, active, worktreePath, SIMULATE ? { validate: dryRun.simulatedBuild } : undefined);
        if (!gate.proceed) {
            return { action: 'skip', reason: gate.reason, status: 'pre-build-failed', taskId, node };
        }
        preBuildNote = gate.note;
    } else if (node === 'implement' && state.preBuildAccepted && state.preBuildStatus === 'failed' && (!decomposed || decomposed.action.kind === 'subtask')) {
        preBuildNote = preBuildAcceptedNote(state); // loop review→implement: erros aceitos continuam valendo
    }

    // Portão de churn (âncora no 1º implement; detecção antes de cada re-implement) —
    // ver runChurnGate. Depois do pré-build: só conta se o implement vai mesmo sair.
    // DRY-RUN pula: o "worktree" é o checkout principal, e a âncora do churn gravaria
    // refs no repo de verdade (e o implement simulado não muda código pra medir).
    // PRI-311 (S5.2b, B5.1/AC-23): churn uma vez por visita, antes da primeira subtarefa dela.
    const churnDue = decomposed
        ? needsChurnGate(state) && decompositionVisit.churnDue(dir, state.decomposition, decomposed.action)
        : needsChurnGate(state);
    if (SIMULATE && churnDue) {
        console.log(`[dry-run] Task ${taskId}: portão de churn pulado (sem worktree git do ticket).`);
    } else if (churnDue) {
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
    let nodeAdmission;
    if (decomposed) {
        // H0 + H6 + DOM-06: baseline no escopo da versão vigente, cadeia contra o Attempt
        // manifestado anterior e só então o Attempt com papel. Cadeia quebrada → blocked.
        const admitted = decomposed.admit();
        if (!admitted.ok) {
            return applyDecompositionBlock({ ticket, taskId, node, state, dir, pending: decompositionBlockPending(null, admitted.reason, node) });
        }
        if (admitted.store_error) console.error(`Task ${taskId}: baseline local não gravado (${admitted.store_error}) — a saída fecha com post UNKNOWN (fail-closed).`);
        nodeAdmission = admitted.admission;
    } else {
        nodeAdmission = dom06.prepareDispatch({
            ...(nodeRouting ? { routing: nodeRoutingSnapshot, routingDecision: nodeRouting.decision } : {}),
            runDir: dir,
            node,
            ticketId: id,
            baseBranch: base,
            specHash: dom06SpecHash(state, worktreePath, id),
            state,
        });
    }
    if (!nodeAdmission.dispatch) {
        console.warn(`Task ${taskId}: admissão DOM06 ${nodeAdmission.attempt.result} (${nodeAdmission.reason}) — ${node} não despachado e não conta como PASS.`);
        return { action: 'skip', reason: `dom06_${String(nodeAdmission.attempt.result).toLowerCase()}`, taskId, node, admission: nodeAdmission.attempt.result };
    }
    const lease = nodeLease.acquireNode(dir, { node, timeoutMs: NODE_TIMEOUT_MS, extra: executionSpec ? { execution_spec: executionSpec } : null });
    attachDom06Lease(lease, nodeAdmission, node, { task: taskId });
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
        ticket, isRecusaQA, qaFeedback, worktreePath, lease, admissionDecision: nodeAdmission, routing: nodeRouting,
        commands: decomposed && decomposed.commands ? decomposed.commands : [`/${node} ${taskId}`],
        nodes: [node],
        contextBlock: decomposed && decomposed.contextBlock ? decomposed.contextBlock : nodeContextBlock(node, { ticket, dir, worktreePath }),
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
            // PRI-311 (S5.2b): a transição implement → review da Run decomposta (feita pelo watcher,
            // sem agente) também avança — o próximo segmento despacha a Review.
            while ((result.action === 'dispatched' || result.action === 'transitioned') && segments < MAX_FOLLOW_SEGMENTS && !watcherState.shuttingDown) {
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
        // PRI-311 (S5.2a, H4): Attempt com papel deixado STARTED fecha UNCERTAIN antes do
        // redespacho; timeout sempre bloqueia. Sem Attempt com papel, nada muda.
        // Mesma origem da task do lease e da varredura: o nome do diretório da Run (C-O-07).
        onOrphan: (dir, state, reason) => decompositionRuntime.closeRoleOrphan({
            runDir: dir, node: state.node, task: path.basename(dir), checkoutRoot: REPO_PATH, orphanReason: reason,
        }),
    });
}

// PRI-311 (S5.2a, H5): chave e manifestos locais saem só quando a task não tem Run em
// nenhuma raiz (checkout principal e cada worktree, runs e runs/_archive). O _archive não é
// terminal: a Recusa QA revive a mesma Run. Idempotente.
function sweepDecompositionKeys() {
    // Mesmas raízes do recovery de órfãos (C-A-09); cada uma com runs/ e runs/_archive.
    return decompositionRuntime.sweepKeys({ checkoutRoot: REPO_PATH, runsDirs: runsRootsForStartup(), filter: taskScopeFilter() || null });
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
    // PRI-181 c0b: valor efetivo da flag a cada tick (sem dado de ticket). Fica em main(),
    // depois do ramo --health-check, para não sujar testes, node-dispatcher nem o JSON do health.
    console.log(QA_DIAGNOSTICO ? '[qa-diagnostico] LIGADO (C1–C3)' : '[qa-diagnostico] desligado (C0)');
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
    if (!DRY_RUN) {
        try {
            const swept = sweepDecompositionKeys();
            if (swept.length) console.log(`[dom06] chave/manifestos locais removidos de ${swept.length} task(s) sem Run em nenhuma raiz.`);
        } catch (e) {
            console.error('[dom06] falha na varredura de chaves (sigo com o tick):', e.message);
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
    QA_DIAGNOSTICO, // PRI-181 c0b: valor efetivo da flag (testes)
    NEVER_AUTO_DISPATCH, looksUnavailable, looksLikeSessionLimit, findLocallyActiveTicketIds,
    notifyBlocked, alreadyNotified, markNotified,
    pretaskQuestionPath, pretaskAnswerPending, notifyPretaskBlocked,
    runTicketSpecGate, runTaskSpecGate, runSpecDriftGate, SPEC_DRIFT_COMMENT_PREFIX, runSpecChangeGate, SPEC_CHANGE_COMMENT_PREFIX, findApprovalReply, fetchRepliesAfter, specGatePath, readSpecGate, syncSpecWarningsToContext, specAccepted,
    specDraftRel, SPEC_APPROVAL_KEYWORD,
    runSpecDraftGate, specDraftComment, SPEC_DRAFT_COMMENT_PREFIX, fillSpecDraftGaps,
    commitRiskNote, checkHumanInput, peekHumanInput, humanInputNote, cleanAgentEnv, recoverOrphanedNodes, NODE_TIMEOUT_MS,
    startPrStatusPolling, prStatusRoots, PR_STATUS_POLL_INTERVAL_MS, onTaskFullyMerged,
    cleanupWorktreesAfterPrOpen, openedPrUrls, notifyOpenedPrsSafe, notifyEscalationWebhook,
    costLedgerPath, readCostLedger, startCostRun, finishCostRun, finalizePendingCostRuns,
    captureTranscript, transcriptStatus,
    collectChangedFiles, stampAffectedServices, testScopeNote,
    collectSchemaDiff, stampSchemaChecklist, schemaChecklistNote,
    needsPlanGate, runPlanGate, planFeedbackNote, PLAN_GATE_COMMENT_PREFIX, PLAN_MAX_REPLANS,
    needsPreBuildGate, runPreBuildGate, worktreeFingerprint, formatPreBuildComment, PRE_BUILD_COMMENT_PREFIX,
    needsChurnGate, runChurnGate, formatChurnComment, CHURN_COMMENT_PREFIX,
    releaseLease, closeRoleAttempt, attachDom06Lease, applyDecompositionBlock, sweepDecompositionKeys,
    prepareDecomposedNode, transitionDecomposedImplement, recordSubagentObservation, DECOMPOSED_GATES,
    syncAcRegistry, collectAcCandidates, AC_REGISTRY_PATH,
    syncKnowledgeGraph, collectKnowledgeFacts, KNOWLEDGE_GRAPH_PATH,
    runMemoryConsolidator, runMemoryConsolidatorSafe, CONSOLIDATOR_STATE_PATH, CONSOLIDATOR_PATTERNS_PATH,
    watcherState, createWatcherState, writeWatcherRuntime, beginCycle, endCycle, runHealthCheck, WATCHER_RUNTIME_FILE,
    // Despacho fora do tick (scripts/lib/node-dispatcher.js → replay de ciclo).
    fetchTicketById, postRedmineNote, BASE_BY_LIBERACAO,
    // Log de agente em tempo real (dashboard GET /api/runs/:taskId/agent-log[/stream]).
    logPathFor, logRun,
};
