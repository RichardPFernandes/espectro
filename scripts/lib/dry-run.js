// Modo DRY-RUN do watcher (DRY_RUN=true no ambiente do processo): roda a orquestração
// de verdade (tick, dispatchTicket, portões, lease, eventos, state.json) contra dados
// fixture, sem nenhuma chamada externa. Tudo que sai do processo é trocado aqui:
//   - Redmine        → createFakeRedmine: responde a partir do fixture, loga os PUTs;
//   - agente Claude  → simulateSegment: escreve o que cada comando escreveria;
//   - mvn compile    → simulatedBuild (portão de build pré-implement);
//   - Bitbucket (PR) → o /commit simulado só loga o PR que abriria.
// installNetworkGuard é a rede de proteção: qualquer fetch/http(s)/processo externo
// que escape dos adaptadores acima estoura DryRunViolation em vez de sair pra rede.
//
// Não confundir com a flag --dry-run (argv) do watcher, bem mais antiga: aquela só
// loga o que despacharia e não escreve nada. Este modo escreve state.json/eventos
// normalmente — o objetivo é exercitar a persistência também.
const fs = require('fs');
const path = require('path');
const specAuthority = require('./spec-authority');
const specVersion = require('./spec-version');

const MODE_FILE = '.watcher-mode';
const TASK_SUFFIX = 'dry-run';
const DEFAULT_FIXTURE = 'scripts/fixtures/ticket-example.json';
// Delays "realistas" por nó (ms), multiplicados por DRY_RUN_DELAY_FACTOR (0 = sem espera).
const NODE_DELAYS_MS = { fetch_ticket: 1000, plan: 2000, implement: 3000, review: 2000, test: 1500, verify: 2000, commit: 1000 };

class DryRunViolation extends Error {
    constructor(what) {
        super(`[dry-run] chamada externa bloqueada em DRY_RUN=true: ${what}`);
        this.name = 'DryRunViolation';
    }
}

function isEnabled(env = process.env) {
    return env.DRY_RUN === 'true';
}

function delayFactor(env = process.env) {
    const raw = env.DRY_RUN_DELAY_FACTOR;
    if (raw === undefined || raw === '') return 1;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 1;
}

// ---------------------------------------------------------------------------------
// Fixture: um ticket no formato de `issue` da API REST do Redmine (o mesmo que o MCP
// devolve), um array deles, ou { issues: [...] }. DRY_RUN_FIXTURE relativo resolve a
// partir do cwd e, se não existir, da raiz do repo (exemplo do CLAUDE.md usa
// ./scripts/fixtures/...). Sem updated_on, carimba "agora": sem isto o ciclo recém
// commitado não seria reconhecido como "já tratado" e --follow recomeçaria o ticket.
function resolveFixturePath(env = process.env, repoRoot = env.REPO_PATH || process.cwd()) {
    const raw = env.DRY_RUN_FIXTURE;
    if (!raw) return path.resolve(repoRoot, DEFAULT_FIXTURE);
    if (path.isAbsolute(raw)) return raw;
    const fromCwd = path.resolve(process.cwd(), raw);
    return fs.existsSync(fromCwd) ? fromCwd : path.resolve(repoRoot, raw);
}

function loadFixtures(fixturePath, { now = new Date() } = {}) {
    let data;
    try {
        data = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    } catch (e) {
        throw new Error(`[dry-run] fixture ilegível (${fixturePath}): ${e.message}`);
    }
    const list = Array.isArray(data) ? data : Array.isArray(data?.issues) ? data.issues : [data];
    return list.map((t, i) => {
        if (!t || !Number.isInteger(t.id) || typeof t.subject !== 'string') {
            throw new Error(`[dry-run] fixture ${fixturePath}: ticket ${i} sem "id" inteiro ou "subject"`);
        }
        return { journals: [], ...t, updated_on: t.updated_on || now.toISOString() };
    });
}

// ---------------------------------------------------------------------------------
// Redmine falso, com a mesma assinatura de lib/redmine-fetch.js (url, init) → Response
// mínima. GET /issues.json → fixtures; GET /issues/<id>.json → o ticket (+ journals, com
// as notas postadas neste processo); PUT /issues/<id>.json → loga a nota e guarda no
// journal (portões que esperam "aceito" enxergam a própria pergunta). Resto: 404.
function fakeResponse(status, body) {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 404 ? 'Not Found' : 'OK',
        headers: { get: () => null },
        json: async () => body,
        text: async () => (body === undefined ? '' : JSON.stringify(body)),
    };
}

function createFakeRedmine({ fixtures, log = console.log } = {}) {
    const byId = new Map(fixtures.map(t => [t.id, t]));
    let journalSeq = 1;
    return async function fakeRedmineFetch(url, init = {}) {
        const method = String(init.method || 'GET').toUpperCase();
        const { pathname } = new URL(String(url), 'http://redmine.dry-run.invalid');
        if (method === 'GET' && /\/issues\.json$/.test(pathname)) {
            log(`[dry-run] Redmine (fixture): GET issues → ${fixtures.length} ticket(s): ${fixtures.map(t => `#${t.id}`).join(', ')}`);
            return fakeResponse(200, { issues: fixtures, total_count: fixtures.length });
        }
        const m = pathname.match(/\/issues\/(\d+)\.json$/);
        const ticket = m && byId.get(Number(m[1]));
        if (!ticket) {
            log(`[dry-run] Redmine (fixture): ${method} ${pathname} → 404 (fora do fixture)`);
            return fakeResponse(404, { errors: ['not found (dry-run)'] });
        }
        if (method === 'GET') return fakeResponse(200, { issue: ticket });
        if (method === 'PUT') {
            let issue = {};
            try { issue = JSON.parse(init.body || '{}').issue || {}; } catch { /* corpo não-JSON: só loga */ }
            if (issue.notes) {
                ticket.journals.push({
                    id: journalSeq++, notes: issue.notes, created_on: new Date().toISOString(),
                    user: { id: 0, name: 'watcher (dry-run)' },
                });
            }
            const firstLine = String(issue.notes || '').split('\n')[0].slice(0, 160);
            log(`[dry-run] Redmine: PUT #${ticket.id} NÃO enviado — ${issue.notes ? `nota que seria postada: "${firstLine}"` : JSON.stringify(issue).slice(0, 160)}`);
            return fakeResponse(204);
        }
        return fakeResponse(404, { errors: ['método não suportado no fake (dry-run)'] });
    };
}

// ---------------------------------------------------------------------------------
// Guarda de rede/processo. Instalada no topo do watcher, ANTES do destructuring de
// child_process — é o objeto do módulo que é trocado, então vale também pros módulos
// carregados depois. Processos locais (git de leitura, node, ps) passam; binários que
// saem pra rede ou são agentes/builds reais estouram.
const BLOCKED_BINARIES = new Set(['claude', 'codex', 'curl', 'wget', 'ssh', 'scp', 'mvn', 'mvnw', 'osascript', 'bitbucket-open-pr.sh', 'gh']);
const GIT_NETWORK_SUBCOMMANDS = new Set(['fetch', 'push', 'pull', 'clone', 'ls-remote', 'remote']);

function gitSubcommand(args) {
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '-C' || a === '-c' || a === '--git-dir' || a === '--work-tree') { i++; continue; }
        if (a.startsWith('-')) continue;
        return a;
    }
    return null;
}

// Devolve a descrição da chamada se ela deve ser bloqueada, ou null.
function blockedCommand(file, args = []) {
    const tokens = [String(file), ...args.map(String)];
    // `sh -c "<script>"` e execSync("<cmd string>"): olha cada palavra do script.
    if (/(^|\/)(ba|z)?sh$/.test(tokens[0]) && tokens[1] === '-c') return blockedCommand(tokens[2] || '');
    const words = tokens.length === 1 ? tokens[0].split(/[\s;|&()`$]+/).filter(Boolean) : tokens;
    for (let i = 0; i < words.length; i++) {
        const bin = path.basename(words[i].replace(/^['"]|['"]$/g, ''));
        if (BLOCKED_BINARIES.has(bin)) return words.slice(i, i + 3).join(' ');
        if (bin === 'git') {
            const sub = gitSubcommand(words.slice(i + 1));
            if (GIT_NETWORK_SUBCOMMANDS.has(sub)) return `git ${sub}`;
        }
        if (tokens.length > 1) break; // argv explícito: só o executável conta
    }
    return null;
}

let guardInstalled = false;

function installNetworkGuard({ log = console.error } = {}) {
    if (guardInstalled) return;
    guardInstalled = true;
    const violation = what => {
        const err = new DryRunViolation(what);
        log(err.message);
        return err;
    };
    // Só o host no log: URL de webhook/API carrega token no caminho ou na query.
    const hostOf = input => { try { return new URL(String(input?.url || input)).host; } catch { return '?'; } };
    globalThis.fetch = async input => { throw violation(`fetch ${hostOf(input)}`); };
    for (const mod of [require('http'), require('https')]) {
        mod.request = () => { throw violation(`${mod === require('https') ? 'https' : 'http'}.request`); };
        mod.get = () => { throw violation(`${mod === require('https') ? 'https' : 'http'}.get`); };
    }
    const cp = require('child_process');
    for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
        const original = cp[name];
        cp[name] = function guarded(file, args, ...rest) {
            const what = blockedCommand(file, Array.isArray(args) ? args : []);
            if (what) throw violation(`${name}(${what})`);
            return original.call(this, file, args, ...rest);
        };
    }
    for (const name of ['exec', 'execSync']) {
        const original = cp[name];
        cp[name] = function guarded(command, ...rest) {
            const what = blockedCommand(String(command));
            if (what) throw violation(`${name}(${what})`);
            return original.call(this, command, ...rest);
        };
    }
}

// ---------------------------------------------------------------------------------
// Portão de build pré-implement: mesmo contrato de build-validator.validateBuild.
async function simulatedBuild() {
    return { success: true, errors: [], duration: 0, javaHome: null, simulated: true };
}

// ---------------------------------------------------------------------------------
// Agente simulado. Recebe o mesmo segmento que iria pro `claude -p` e escreve o que o
// comando de cada nó escreveria (convenção do grafo: state.node já é o PRÓXIMO nó a
// rodar; o status "running" do lease é preservado — quem devolve pra in_progress é o
// release do lease no watcher, como com o agente real). Devolve { code, output,
// stderr, finalize }: finalize roda DEPOIS do release (o /commit arquiva a pasta da
// task, e o evento node_end precisa do state.json ainda no lugar).
const sleep = ms => new Promise(r => setTimeout(r, ms));

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// state.json só pelo scripts/state-writer.js; o fetch_ticket simulado abre o ciclo (init).
function writeState(dir, state) {
    require('../state-writer').write(dir, state, { operation: 'dry_run_node', actor: 'dry-run' });
}

function acceptanceCriteria(description) {
    const lines = String(description || '').split('\n');
    const start = lines.findIndex(l => /^#+\s*crit[ée]rios? de aceite/i.test(l.trim()));
    const out = [];
    for (let i = start + 1; start !== -1 && i < lines.length && !/^#/.test(lines[i].trim()); i++) {
        const m = lines[i].match(/^\s*[-*]\s+(.*\S)/);
        if (m) out.push(m[1]);
    }
    return out;
}

// Plano no formato que scripts/lib/plan-scorer.js pontua: 3–10 passos numerados, cada
// um com "Arquivo:" e "Verificação:", um por critério de aceite.
function simulatedHandoff(ticket, taskId) {
    const acs = acceptanceCriteria(ticket.description);
    const items = acs.length ? acs.slice(0, 10) : ['Implementar o pedido do ticket'];
    while (items.length < 3) items.push(items.length === 1 ? 'Cobrir a mudança com teste automatizado' : 'Revisar o diff final da mudança');
    const steps = items.map((ac, i) =>
        `${i + 1}. ${ac}\n   - Arquivo: src/main/java/.../DryRun${i + 1}.java (simulado)\n   - Verificação: teste automatizado confirma "${ac}"`);
    return (
        `# Handoff — ${taskId} [DRY-RUN]\n\n` +
        `Gerado pelo agente simulado do watcher (DRY_RUN=true) — nenhum agente real rodou.\n\n` +
        `## Plano de execução\n\n${steps.join('\n\n')}\n`
    );
}

function prInfo(ticket, state) {
    const high = state.risk_level === 'high';
    const branch = String(ticket.id);
    const target = state.redmine_ticket?.base_branch || 'development';
    return {
        url: `https://bitbucket.org/[DRY-RUN]/${process.env.WATCHER_MAIN_REPO_NAME || path.basename(process.env.REPO_PATH || process.cwd())}/pullrequests/0`,
        repo: process.env.WATCHER_MAIN_REPO_NAME || path.basename(process.env.REPO_PATH || process.cwd()), branch, target, draft: true,
        title: `${high ? '[HIGH-RISK] ' : ''}${ticket.id} - ${ticket.subject}`,
    };
}

async function simulateSegment({ ticket, nodes, lease, runsDir, baseBranch, extraNote = '', env = process.env, log = console.log }) {
    const factor = delayFactor(env);
    const now = () => new Date().toISOString();
    const taskId = `${ticket.id}-${TASK_SUFFIX}`;
    let dir = lease?.dir || path.join(runsDir, taskId);
    let finalize = null;

    for (const node of nodes) {
        const ms = Math.round((NODE_DELAYS_MS[node] ?? 1000) * factor);
        log(`[dry-run] Simulando nó ${node} para task ${taskId} (${ms}ms)...`);
        await sleep(ms);

        if (node === 'fetch_ticket') {
            if (fs.existsSync(path.join(dir, 'state.json')) && !readJson(path.join(dir, 'state.json')).dry_run) {
                throw new Error(`[dry-run] ${dir} já tem um state.json que não é de dry-run — não sobrescrevo`);
            }
            fs.rmSync(dir, { recursive: true, force: true });
            fs.mkdirSync(dir, { recursive: true });
            // Spec dentro da pasta do run, não em memory/spec/: ali o registro de ACs e o
            // knowledge graph do watcher real indexariam o ticket fictício.
            fs.writeFileSync(path.join(dir, 'spec.md'), `# [DRY-RUN] Spec simulada — #${ticket.id}\n\n${ticket.description || ''}\n`);
            fs.writeFileSync(path.join(dir, 'context.md'), `# Contexto — ${taskId} [DRY-RUN]\n\nTicket #${ticket.id}: ${ticket.subject}\n`);
            const at = now();
            const fresh = {
                task_id: taskId, node: 'plan', history: ['fetch_ticket'], retries: {}, status: 'in_progress',
                started_at: at, updated_at: at, dry_run: true,
                // Só os IDs (o texto fica na spec), como o /fetch-ticket real grava.
                ac_ids: acceptanceCriteria(ticket.description).map(t => (/^AC-\d+(?=:)/.exec(t) || [])[0]).filter(Boolean),
                redmine_ticket: { id: ticket.id, subject: ticket.subject, tracker: ticket.tracker?.name || '?', base_branch: baseBranch },
                spec_path: `memory/runs/${taskId}/spec.md`,
            };
            // Bloco state.spec (spec-version.js init) como o /fetch-ticket real; changelog
            // ao lado da spec simulada, dentro do dir do run.
            specVersion.init(fresh, {
                root: path.resolve(dir, '..', '..', '..'), specRel: fresh.spec_path, taskId, now: at,
                content: fs.readFileSync(path.join(dir, 'spec.md'), 'utf8'),
            });
            require('../state-writer').init(dir, fresh);
            log(`[dry-run] Redmine: #${ticket.id} seria movido para "Em Desenvolvimento" (MCP updateIssue não chamado)`);
        } else {
            const state = readJson(path.join(dir, 'state.json'));
            state.history = [...(state.history || []), node];
            if (node === 'plan') {
                fs.writeFileSync(path.join(dir, 'handoff.md'), simulatedHandoff(ticket, taskId));
                Object.assign(state, { node: 'implement', scope: '[DRY-RUN] escopo simulado', selected_context: [], handoff_path: `memory/runs/${taskId}/handoff.md` });
                // Baseline do spec_hash como o /plan real (a spec simulada fica no dir do run):
                // exercita o portão de drift do watcher nos nós seguintes.
                specAuthority.applyBaseline(state, { root: path.resolve(dir, '..', '..', '..'), specPath: `memory/runs/${taskId}/spec.md`, by: 'plan', now: now(), taskId });
            } else if (node === 'implement') {
                fs.appendFileSync(path.join(dir, 'context.md'), `\n- ${now()} [DRY-RUN] implement simulado (nenhum arquivo de código alterado)\n`);
                state.node = 'review';
            } else if (node === 'review') {
                // Mesmo formato do review-result.js record (duas dimensões + failure_origin).
                const at = now();
                Object.assign(state, {
                    node: 'test', review_verdict: 'aprovado (simulado)',
                    review_results: {
                        verdict: 'PASS', failure_origin: null, reviewed_at: at, round: 1,
                        spec_compliance: { verdict: 'PASS', acs: {}, checks: {} },
                        engineering: { verdict: 'PASS', items: {} },
                        divergences: [], findings: [], spec_clarifications: [], technical_decisions_applied: [], observations: ['[DRY-RUN] review simulado'],
                        spec_hash: state.spec_hash || null,
                        history: [{ round: 1, reviewed_at: at, verdict: 'PASS', failure_origin: null }],
                    },
                });
            } else if (node === 'test') {
                Object.assign(state, { node: 'verify', test_result: 'pass (simulado)' });
            } else if (node === 'verify') {
                const high = env.DRY_RUN_RISK_LEVEL === 'high';
                Object.assign(state, {
                    node: 'commit', verify_verdict: 'pass (simulado)', risk_level: high ? 'high' : 'low',
                    risk_reason: high ? '[DRY-RUN] DRY_RUN_RISK_LEVEL=high' : '[DRY-RUN] nenhum critério de risco (simulado)',
                });
            } else if (node === 'commit') {
                const pr = prInfo(ticket, state);
                log(`[dry-run] PR que seria aberto: ${pr.url}`);
                log(`[dry-run]   repo: ${pr.repo}, branch: ${pr.branch} → ${pr.target}, draft: ${pr.draft}, título: "${pr.title}"`);
                if (extraNote.trim()) log(`[dry-run]   instrução de risco do watcher: ${extraNote.trim().slice(0, 200)}`);
                log(`[dry-run] Redmine: #${ticket.id} seria atualizado pelo /commit (MCP updateIssue não chamado)`);
                // Fora de state.pull_request: o polling de PRs e a limpeza de worktrees do
                // watcher real iriam atrás desta URL.
                Object.assign(state, { status: 'committed', dry_run_pull_request: { [pr.repo]: pr } });
                finalize = () => archiveTask(dir, runsDir, taskId, log);
            }
            state.updated_at = now();
            writeState(dir, state);
        }
        log(`[dry-run] Nó ${node} completado (simulado)`);
    }
    return { code: 0, output: '', stderr: '', simulated: true, finalize };
}

// Mesmo passo 9 do /commit: memory/runs/<task-id>/ → memory/runs/_archive/<task-id>/.
// Um arquivado anterior do MESMO task-id só é substituído se também for de dry-run.
function archiveTask(dir, runsDir, taskId, log = console.log) {
    const target = path.join(runsDir, '_archive', taskId);
    if (fs.existsSync(target)) {
        let previous = null;
        try { previous = readJson(path.join(target, 'state.json')); } catch { /* sem state: trata como alheio */ }
        if (!previous?.dry_run) throw new Error(`[dry-run] ${target} existe e não é de dry-run — não arquivo por cima`);
        fs.rmSync(target, { recursive: true, force: true });
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(dir, target);
    log(`[dry-run] Task ${taskId} arquivada em ${path.relative(path.join(runsDir, '..', '..'), target)}/ (status committed)`);
    return target;
}

// ---------------------------------------------------------------------------------
// .watcher-mode (memory/runs/.watcher-mode): gravado no startup de cada tick, lido pelo
// dashboard (GET /api/watcher/mode) pro banner de DRY-RUN. O tick normal regrava com
// mode="live" — o banner some quando o watcher volta pro modo real.
function writeModeFile(runsDir, info) {
    fs.mkdirSync(runsDir, { recursive: true });
    fs.writeFileSync(path.join(runsDir, MODE_FILE), JSON.stringify({ ...info, updated_at: new Date().toISOString() }, null, 2));
}

function readModeFile(runsDir) {
    try {
        return JSON.parse(fs.readFileSync(path.join(runsDir, MODE_FILE), 'utf8'));
    } catch {
        return null;
    }
}

module.exports = {
    DryRunViolation, isEnabled, delayFactor,
    resolveFixturePath, loadFixtures, DEFAULT_FIXTURE,
    createFakeRedmine, installNetworkGuard, blockedCommand,
    simulatedBuild, simulateSegment, simulatedHandoff, acceptanceCriteria, archiveTask,
    writeModeFile, readModeFile, MODE_FILE, TASK_SUFFIX, NODE_DELAYS_MS,
};
