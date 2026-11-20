// node --test scripts/lib/decomposition-visit.test.js
// PRI-311 (PRI-287 S5.2b): visita ao Implement da Run decomposta — B2, B5, B6 (SPEC v2.1) no
// nível da lib. Attempts gravados pelo DOM-06 real; manifestos em repositórios git sintéticos.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const dom06 = require('./dom06-attempt');
const rt = require('./decomposition-runtime');
const visit = require('./decomposition-visit');
const planSignals = require('./plan-signals');

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'deco-visit-')));
test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const PLAN = [
    '# Plano', '', '## Plano de execução', '',
    '1. Ajustar o serviço.', '   - Arquivo: `src/servico.js`', '   - Critérios: AC-01', '   - Verificação: teste unitário do serviço', '',
    '2. Ajustar a documentação.', '   - Arquivo: `docs/leia.md`', '   - Critérios: AC-02', '   - Verificação: leitura', '',
].join('\n');
const PLAN_REPLAN = PLAN.replace('Ajustar a documentação.', 'Reescrever a documentação.');
const PLAN_INTERLEAVED = [
    '# Plano', '', '## Plano de execução', '',
    '1. A.', '   - Arquivo: `src/a.js`', '',
    '2. B.', '   - Arquivo: `src/b.js`', '',
    '3. A de novo.', '   - Arquivo: `src/a.js`', '',
].join('\n');
const PLAN_UNKNOWN = [
    '# Plano', '', '## Plano de execução', '',
    '1. Ajustar o serviço.', '   - Arquivo: `src/servico.js`', '',
    '2. Investigar o log sem arquivo declarado.', '',
].join('\n');

let n = 0;
function runDir() {
    const dir = path.join(tmpRoot, `r${n++}`, 'memory', 'runs', `1-t${n}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function decomposed(plan = PLAN) {
    return visit.recordDecomposition({}, plan, '2026-11-09T10:00:00.000Z').decomposition;
}

const ADMITTED = { status: 'ADMITTED', owner: 'dom06', snapshot: { ticket_id: 1, node: 'implement', base_branch: 'main', spec_hash: null } };

// Attempt com papel pelo DOM-06 real; `acceptance`/`effects` aplicados depois, como a saída faria.
function inject(dir, { role, key = null, pv, node = 'implement', acceptance = null, fulfil = false, scopeViolation = undefined, parent = null, routingClass = undefined }) {
    const r = dom06.beginAttempt(dir, {
        node, admission: ADMITTED, ...(routingClass !== undefined ? { routing: { class: routingClass } } : {}),
        decomposition: { role, plan_version: pv, ...(role === 'subtask' ? { subtask_key: key } : {}), parent_attempt_id: parent },
    });
    const file = r.attemptFile;
    if (acceptance) {
        const a = JSON.parse(fs.readFileSync(file, 'utf8'));
        a.acceptance = { decided_at: new Date().toISOString(), ...acceptance };
        if (scopeViolation !== undefined) { a.scope_violation = scopeViolation; a.scope_check = { comparable: true, outside_count: scopeViolation ? 1 : 0 }; }
        fs.writeFileSync(file, JSON.stringify(a));
    }
    if (fulfil) {
        const id = r.attempt.attempt_id;
        const ob = role === 'subtask' ? `execute_subtask:${key}` : `integrate:${pv}`;
        dom06.recordEffect(file, { obligation_id: ob, idempotency_key: `execute:${id}`, status: 'fulfilled' });
    }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const ACCEPTED = { accepted: true, reason: null, block: false, retry_allowed: false };

test('B2: decomposição gravável — grupos por arquivo, chaves D14, ACs e superseded no replan', () => {
    const d = decomposed();
    assert.strictEqual(d.status, 'DECOMPOSABLE');
    assert.strictEqual(d.groups.length, 2);
    const pv = planSignals.extractPlanSteps(PLAN).plan_version;
    assert.strictEqual(d.plan_version, pv);
    assert.deepStrictEqual(d.groups.map(g => g.subtask_key), [`${pv.slice(0, 12)}/1-1`, `${pv.slice(0, 12)}/2-2`]);
    assert.deepStrictEqual(d.groups.map(g => g.acs), [['AC-01'], ['AC-02']]);
    assert.ok(d.groups.every(g => !('initial_class' in g) && !('initial_resolution' in g)), 'resolução inicial vem do Attempt (DOM-06), sem cópia no state');
    assert.strictEqual(d.plan_visits, 0);
    assert.deepStrictEqual(d.scope_paths, ['docs/leia.md', 'src/servico.js']);
    // Mesma versão: nada muda.
    assert.strictEqual(visit.recordDecomposition({ decomposition: d }, PLAN).changed, false);
    // plan.md mudou sem visita nova ao Plan: recusado, nada reinterpretado.
    const refused = visit.recordDecomposition({ decomposition: d, history: [] }, PLAN_REPLAN);
    assert.deepStrictEqual([refused.changed, refused.refused, refused.decomposition], [false, 'PLAN_CHANGED_OUTSIDE_PLAN', d]);
    // Replan (visita nova ao Plan): versão nova; chaves antigas SUPERSEDED, nada herdado por posição.
    const r = visit.recordDecomposition({ decomposition: d, history: ['plan'] }, PLAN_REPLAN);
    assert.strictEqual(r.changed, true);
    assert.notStrictEqual(r.decomposition.plan_version, d.plan_version);
    assert.deepStrictEqual(r.decomposition.superseded.map(s => [s.subtask_key, s.status]), d.groups.map(g => [g.subtask_key, 'SUPERSEDED']));
    assert.strictEqual(r.decomposition.rework, null);
});

test('B2: intercalado e sem plano → NOT_DECOMPOSABLE (caminho da S4); passo sem Arquivo → UNKNOWN em C4', () => {
    const inter = decomposed(PLAN_INTERLEAVED);
    assert.deepStrictEqual([inter.status, inter.cause], ['NOT_DECOMPOSABLE', 'INTERLEAVED_GROUPS']);
    const none = decomposed('# Plano\n\nsem bloco\n');
    assert.deepStrictEqual([none.status, none.cause], ['NOT_DECOMPOSABLE', 'PLAN_BLOCK_NOT_FOUND']);
    const unk = decomposed(PLAN_UNKNOWN);
    assert.strictEqual(unk.status, 'DECOMPOSABLE');
    assert.strictEqual(unk.groups[1].paths_decl, 'UNKNOWN');
    assert.deepStrictEqual(visit.classFloor({ runDir: runDir(), decomposition: unk, key: unk.groups[1].subtask_key }), { class: 'C4', selection_source: 'CONSERVATIVE_DEFAULT' });
    // k = 1: subtarefa + integração, sem atalho.
    const one = decomposed(['# Plano', '', '## Plano de execução', '', '1. Único.', '   - Arquivo: `src/x.js`', ''].join('\n'));
    const dir = runDir();
    assert.strictEqual(visit.nextAction({ runDir: dir, state: {}, decomposition: one }).kind, 'subtask');
    inject(dir, { role: 'subtask', key: one.groups[0].subtask_key, pv: one.plan_version, acceptance: ACCEPTED, fulfil: true });
    assert.strictEqual(visit.nextAction({ runDir: dir, state: {}, decomposition: one }).kind, 'integration');
});

test('AC-22 (lib): subtarefas em ordem, uma por vez; integração depois de todas; agregação; Review só com aggregate:<pv>', () => {
    const d = decomposed();
    const [k1, k2] = d.groups.map(g => g.subtask_key);
    const dir = runDir();
    const next = () => visit.nextAction({ runDir: dir, state: {}, decomposition: d });
    assert.deepStrictEqual(next(), { kind: 'subtask', key: k1, rework: false, cause: 'dispatch', parent_attempt_id: null });
    const a1 = inject(dir, { role: 'subtask', key: k1, pv: d.plan_version });
    assert.deepStrictEqual(next(), { kind: 'wait', attempt_id: a1.attempt_id }, 'Attempt em voo: nada novo');
    fs.writeFileSync(path.join(dir, 'dom06', 'attempts', `${a1.attempt_id}.json`), JSON.stringify({ ...a1, acceptance: { ...ACCEPTED, decided_at: new Date().toISOString() } }));
    assert.strictEqual(next().key, k2, 'a segunda chave só depois da primeira aceita');
    inject(dir, { role: 'subtask', key: k2, pv: d.plan_version, acceptance: ACCEPTED, fulfil: true });
    assert.deepStrictEqual(next(), { kind: 'integration', cause: 'dispatch', parent_attempt_id: null });
    assert.strictEqual(visit.reviewAllowed(dir, d.plan_version), false, 'sem agregação, a Review não pode ser despachada');
    inject(dir, { role: 'integration', pv: d.plan_version, acceptance: ACCEPTED, fulfil: true });
    const act = next();
    assert.strictEqual(act.kind, 'aggregate');
    // A primeira chave ainda não tem a obrigação cumprida (injetada sem fulfil) — a agregação
    // olha o aceite do último Attempt de cada chave e a integração posterior.
    const agg = dom06.aggregateImplement(dir, d.plan_version, act.keys);
    assert.strictEqual(agg.ok, true, JSON.stringify(agg));
    assert.strictEqual(visit.reviewAllowed(dir, d.plan_version), true);
});

test('B5: retry sem mutação, bloqueio, redespacho só depois de ato humano, falha da integração', () => {
    const d = decomposed();
    const [k1] = d.groups.map(g => g.subtask_key);
    const dir = runDir();
    const failed = inject(dir, { role: 'subtask', key: k1, pv: d.plan_version, acceptance: { accepted: false, reason: 'OPERATIONAL_FAILURE', block: false, retry_allowed: true } });
    assert.deepStrictEqual(visit.nextAction({ runDir: dir, state: {}, decomposition: d }),
        { kind: 'subtask', key: k1, rework: false, cause: 'retry', parent_attempt_id: failed.attempt_id });
    const blocked = inject(dir, { role: 'subtask', key: k1, pv: d.plan_version, parent: failed.attempt_id, acceptance: { accepted: false, reason: 'RETRY_CEILING', block: true, retry_allowed: false } });
    assert.deepStrictEqual(visit.nextAction({ runDir: dir, state: {}, decomposition: d }), { kind: 'blocked', attempt_id: blocked.attempt_id, reason: 'RETRY_CEILING' });
    const later = new Date(Date.now() + 60000).toISOString();
    assert.deepStrictEqual(visit.nextAction({ runDir: dir, state: { unblocked: { at: later, by: 'richard' } }, decomposition: d }),
        { kind: 'subtask', key: k1, rework: false, cause: 'dispatch', parent_attempt_id: blocked.attempt_id }, 'HUMAN_UNBLOCK: nova tentativa encadeada');
});

test('B5: retomada humana vem antes do retry (dispatch); CLAIM_LOST sem mutação não redespacha; STATUS_CHANGED redespacha', () => {
    const d = decomposed();
    const [k1] = d.groups.map(g => g.subtask_key);
    const later = new Date(Date.now() + 60000).toISOString();
    const dir = runDir();
    const exempt = inject(dir, { role: 'subtask', key: k1, pv: d.plan_version, acceptance: { accepted: false, reason: 'OPERATIONAL_FAILURE_EXEMPT', block: false, retry_allowed: true, exempt: true } });
    assert.strictEqual(visit.nextAction({ runDir: dir, state: {}, decomposition: d }).cause, 'retry');
    assert.deepStrictEqual(visit.nextAction({ runDir: dir, state: { resumed_at: later }, decomposition: d }),
        { kind: 'subtask', key: k1, rework: false, cause: 'dispatch', parent_attempt_id: exempt.attempt_id }, 'HUMAN_RESUME entra como dispatch (H2)');
    const dir2 = runDir();
    const lost = inject(dir2, { role: 'subtask', key: k1, pv: d.plan_version, acceptance: { accepted: false, reason: 'CLAIM_LOST', block: false, retry_allowed: false } });
    assert.deepStrictEqual(visit.nextAction({ runDir: dir2, state: {}, decomposition: d }), { kind: 'blocked', attempt_id: lost.attempt_id, reason: 'CLAIM_LOST' });
    const dir3 = runDir();
    const changed = inject(dir3, { role: 'subtask', key: k1, pv: d.plan_version, acceptance: { accepted: false, reason: 'STATUS_CHANGED', block: false, retry_allowed: false } });
    assert.deepStrictEqual(visit.nextAction({ runDir: dir3, state: {}, decomposition: d }).parent_attempt_id, changed.attempt_id);
});

test('AC-25 (lib): achado mapeado → rework só da chave; sem mapeamento → ALL; Test/Verify → ALL', () => {
    const d = decomposed();
    const [k1, k2] = d.groups.map(g => g.subtask_key);
    const all = dom06.allKey(d.plan_version);
    assert.deepStrictEqual(visit.mapFindings({ decomposition: d, gateNode: 'review', findings: [{ file: 'docs/leia.md', line: 3 }] }).keys, [k2]);
    assert.deepStrictEqual(visit.mapFindings({ decomposition: d, gateNode: 'review', findings: [{ file: './src/servico.js:10' }, { file: 'docs/leia.md' }] }).keys, [k1, k2]);
    assert.deepStrictEqual(visit.mapFindings({ decomposition: d, gateNode: 'review', findings: [{ file: 'docs/leia.md' }, { file: 'pom.xml' }] }).keys, [k2, all]);
    assert.deepStrictEqual(visit.mapFindings({ decomposition: d, gateNode: 'review', findings: [{ ac: 'AC-01', file: null }] }).keys, [all]);
    assert.deepStrictEqual(visit.mapFindings({ decomposition: d, gateNode: 'test', findings: [{ file: 'docs/leia.md' }] }).keys, [all]);

    // Volta de gate: rework gravado uma vez por gate; só a chave mapeada; depois nova integração.
    const dir = runDir();
    inject(dir, { role: 'subtask', key: k1, pv: d.plan_version, acceptance: ACCEPTED, fulfil: true });
    inject(dir, { role: 'subtask', key: k2, pv: d.plan_version, acceptance: ACCEPTED, fulfil: true });
    inject(dir, { role: 'integration', pv: d.plan_version, acceptance: ACCEPTED, fulfil: true });
    const gate = inject(dir, { role: 'gate', pv: d.plan_version, node: 'review' });
    const state = { review_results: { verdict: 'FAIL', findings: [{ file: 'docs/leia.md', line: 1 }] } };
    assert.deepStrictEqual(visit.nextAction({ runDir: dir, state, decomposition: d }), { kind: 'rework_pending' });
    const rework = visit.pendingRework({ runDir: dir, state, decomposition: d });
    assert.deepStrictEqual([rework.gate_attempt_id, rework.gate_node, rework.keys, rework.failure_class], [gate.attempt_id, 'review', [k2], null]);
    const d2 = { ...d, rework };
    assert.strictEqual(visit.pendingRework({ runDir: dir, state, decomposition: d2 }), null, 'uma vez por gate');
    const act = visit.nextAction({ runDir: dir, state, decomposition: d2 });
    assert.strictEqual(act.key, k2);
    assert.strictEqual(act.rework, true);
    assert.ok(act.parent_attempt_id, 'rework encadeia o último Attempt da linhagem');
    inject(dir, { role: 'subtask', key: k2, pv: d.plan_version, acceptance: ACCEPTED, fulfil: true, parent: act.parent_attempt_id });
    assert.strictEqual(visit.nextAction({ runDir: dir, state, decomposition: d2 }).kind, 'integration', 'k1 não é refeita; nova integração');
});

test('AC-24/AC-25 (lib): piso da linhagem — rework ≥ resolução inicial; scope_violation e ALL ≥ C4 com RISK_RECLASSIFIED', () => {
    const d = decomposed();
    const [k1, k2] = d.groups.map(g => g.subtask_key);
    const dir = runDir();
    assert.strictEqual(visit.classFloor({ runDir: dir, decomposition: d, key: k1 }), null, 'primeiro Attempt: sem piso (resolução inicial)');
    inject(dir, { role: 'subtask', key: k1, pv: d.plan_version, acceptance: ACCEPTED, routingClass: 'C2' });
    assert.deepStrictEqual(visit.classFloor({ runDir: dir, decomposition: d, key: k1 }), { class: 'C2', selection_source: 'LINEAGE_FLOOR' }, 'piso = classe da RoutingDecision do 1º Attempt');
    inject(dir, { role: 'subtask', key: k2, pv: d.plan_version, acceptance: ACCEPTED, scopeViolation: true, routingClass: 'C1' });
    assert.deepStrictEqual(visit.classFloor({ runDir: dir, decomposition: d, key: k2 }), { class: 'C4', selection_source: 'RISK_RECLASSIFIED' });
    assert.deepStrictEqual(visit.classFloor({ runDir: dir, decomposition: d, key: dom06.allKey(d.plan_version) }), { class: 'C4', selection_source: 'RISK_RECLASSIFIED', exact: true });
    // Nenhuma reclassificação vira escalation: nenhuma causa reservada é usada.
    assert.ok(!dom06.listAttempts(dir).some(a => a.cause === 'escalation' || a.escalation_proposal));
});

test('AC-23 (lib): pré-build uma vez antes da 1ª subtarefa; churn uma vez por visita', () => {
    const d = decomposed();
    const [k1, k2] = d.groups.map(g => g.subtask_key);
    const dir = runDir();
    const sub = key => ({ kind: 'subtask', key });
    assert.strictEqual(visit.preBuildDue(dir), true);
    assert.strictEqual(visit.churnDue(dir, d, sub(k1)), true);
    inject(dir, { role: 'subtask', key: k1, pv: d.plan_version, acceptance: ACCEPTED, fulfil: true });
    assert.strictEqual(visit.preBuildDue(dir), false, 'pré-build não roda antes da segunda subtarefa');
    assert.strictEqual(visit.churnDue(dir, d, sub(k2)), false, 'churn não roda de novo na mesma visita');
    assert.strictEqual(visit.churnDue(dir, d, { kind: 'integration' }), false);
    inject(dir, { role: 'subtask', key: k2, pv: d.plan_version, acceptance: ACCEPTED, fulfil: true });
    inject(dir, { role: 'integration', pv: d.plan_version, acceptance: ACCEPTED, fulfil: true });
    inject(dir, { role: 'gate', pv: d.plan_version, node: 'review' });
    assert.strictEqual(visit.churnDue(dir, d, sub(k2)), true, 'visita de rework: churn uma vez de novo');
    assert.strictEqual(visit.preBuildDue(dir), false);
});

test('AC-28: DoD derivado (ACs, verificação, manifesto) gravado no Attempt; não aprova nem reprova', () => {
    const d = decomposed();
    const g = d.groups[0];
    const dod = visit.deriveDod({ group: g, planContent: PLAN });
    assert.deepStrictEqual(dod, {
        items: [
            { kind: 'ac', ref: 'AC-01' },
            { kind: 'verification', step: 1, text: 'teste unitário do serviço' },
            { kind: 'manifest', text: 'manifesto post COMPLETE, sem arquivo fora de paths_decl' },
        ],
        source: 'derived', self_reported_status: null,
    });
    const ctx = visit.stepContextBlock({ taskId: '1-t', group: g, planContent: PLAN, dod });
    assert.match(ctx.block, /subtask-context:.*:inicio/);
    assert.match(ctx.block, /src\/servico\.js/);
    assert.strictEqual(ctx.sha256, crypto.createHash('sha256').update(ctx.block).digest('hex'));
    assert.strictEqual(visit.stepContextBlock({ taskId: '1-t', group: g, planContent: PLAN, dod }).sha256, ctx.sha256, 'Context Record determinístico');
    // O DoD vai no Attempt e o aceite ignora o DoD (igual com e sem itens "não feitos").
    const dir = runDir();
    const r = dom06.beginAttempt(dir, { node: 'implement', admission: ADMITTED, decomposition: { role: 'subtask', plan_version: d.plan_version, subtask_key: g.subtask_key, dod, context_record_sha256: ctx.sha256 } });
    assert.deepStrictEqual(r.attempt.dod, dod);
    assert.strictEqual(r.attempt.context_record_sha256, ctx.sha256);
    const base = { attempt: { ...r.attempt, workspace: { baseline: { digest: 'x', completeness: 'COMPLETE' } } }, code: 0, claim: 'RELEASED', post: { digest: 'y', completeness: 'COMPLETE' }, currentPlanVersion: d.plan_version };
    const withDod = dom06.decideAcceptance(base);
    const noDod = dom06.decideAcceptance({ ...base, attempt: { ...base.attempt, dod: { ...dod, self_reported_status: 'NOT_DONE' } } });
    assert.deepStrictEqual(withDod, noDod);
    assert.strictEqual(withDod.accepted, true);
});

// --- scope_violation com manifestos reais (B5.8) ---
const GIT_ENV = {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'm', GIT_AUTHOR_EMAIL: 'm@example.invalid', GIT_COMMITTER_NAME: 'm', GIT_COMMITTER_EMAIL: 'm@example.invalid',
};
const env = { PATH: process.env.PATH, ...GIT_ENV };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
function gitRepo(dir) {
    fs.mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    write(dir, '.gitignore', 'memory/runs/\n');
    write(dir, 'src/servico.js', 'module.exports = 1;\n');
    write(dir, 'docs/leia.md', '# leia\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'base');
}

test('B5.8: scope_violation pela comparação baseline × post local; memory/ não conta; registro uma vez', () => {
    const base = path.join(tmpRoot, `sv${n++}`);
    const checkout = path.join(base, 'checkout');
    const worktree = path.join(base, 'wt');
    gitRepo(checkout);
    gitRepo(worktree);
    const task = `1-sv${n}`;
    const dir = path.join(worktree, 'memory', 'runs', task);
    fs.mkdirSync(dir, { recursive: true });
    const d = decomposed();
    const k1 = d.groups[0].subtask_key;
    const r = rt.prepareRoleDispatch({
        runDir: dir, checkoutRoot: checkout, task, worktree, decomposition: { role: 'subtask', plan_version: d.plan_version, subtask_key: k1 },
        scopePaths: d.scope_paths, state: {}, dispatch: { node: 'implement', ticketId: 1, baseBranch: 'main' }, env,
    });
    assert.strictEqual(r.ok, true);
    const attempt = r.admission.attempt;
    write(worktree, 'src/servico.js', 'module.exports = 2;\n'); // dentro de paths_decl
    write(worktree, 'docs/leia.md', '# fora do grupo 1\n'); // fora (é do grupo 2)
    write(worktree, 'memory/spec/1-spec.md', 'decisão\n'); // registro da plataforma: não conta
    const paths = rt.manifestPaths(checkout);
    const fresh = JSON.parse(fs.readFileSync(r.admission.attemptFile, 'utf8'));
    rt.observeInBaselineScope({ paths, task, attempt: fresh, worktree, phase: 'post', env });
    const chk = visit.scopeCheck({ checkoutRoot: checkout, task, attempt, decomposition: d });
    assert.deepStrictEqual(chk, { comparable: true, count: 1 });
    dom06.recordScopeViolation(r.admission.attemptFile, chk);
    const after = JSON.parse(fs.readFileSync(r.admission.attemptFile, 'utf8'));
    assert.strictEqual(after.scope_violation, true);
    assert.strictEqual(after.scope_check.outside_count, 1);
    assert.ok(!JSON.stringify(after).includes('docs/leia.md'), 'o Attempt guarda só a contagem, nunca caminho do manifesto');
    dom06.recordScopeViolation(r.admission.attemptFile, { comparable: true, count: 0 });
    assert.strictEqual(JSON.parse(fs.readFileSync(r.admission.attemptFile, 'utf8')).scope_check.outside_count, 1, 'gravado uma vez');
    // Sem manifestos comparáveis: não comparável, sem reclassificação.
    assert.deepStrictEqual(visit.scopeCheck({ checkoutRoot: checkout, task, attempt: { ...attempt, attempt_id: crypto.randomUUID() }, decomposition: d }), { comparable: false, count: null });
});

test('B8: agentes do projeto — redefinição só fiel; lista YAML, campo extra ou bloco → não reproduzível (fail-closed)', () => {
    const wt = path.join(tmpRoot, `ag${n++}`);
    write(wt, '.claude/agents/revisor.md', '---\nname: revisor\ndescription: Revisa código\ntools: Read, Grep\nmodel: haiku\ncolor: blue\n---\nVocê revisa.\n');
    write(wt, '.claude/agents/lista.md', '---\nname: lista\ndescription: x\ntools:\n  - Read\n  - Grep\n---\ncorpo\n');
    write(wt, '.claude/agents/extra.md', '---\nname: extra\ndescription: x\ndisallowedTools: Bash\n---\ncorpo\n');
    write(wt, '.claude/agents/bloco.md', '---\nname: bloco\ndescription: >-\n  longa\n---\ncorpo\n');
    write(wt, '.claude/agents/sem-tools.md', '---\nname: sem-tools\ndescription: herda\n---\ncorpo\n');
    write(wt, '.claude/agents/sem-nome.md', '---\ndescription: x\n---\ncorpo\n');
    write(wt, '.claude/agents/notas.txt', 'ignorado');
    const byName = Object.fromEntries(visit.readProjectAgents(wt).map(a => [a.name, a]));
    assert.deepStrictEqual(Object.keys(byName).sort(), ['bloco', 'extra', 'lista', 'revisor', 'sem-tools']);
    assert.deepStrictEqual(byName.revisor, { name: 'revisor', redefinable: true, definition: { description: 'Revisa código', prompt: 'Você revisa.', tools: ['Read', 'Grep'] } });
    assert.deepStrictEqual(byName['sem-tools'].definition, { description: 'herda', prompt: 'corpo' }, 'sem tools no frontmatter = sem tools na redefinição (mesma herança)');
    for (const name of ['lista', 'extra', 'bloco']) assert.deepStrictEqual(byName[name], { name, redefinable: false, cause: 'AGENT_NOT_REPRODUCIBLE' });
    assert.deepStrictEqual(visit.readProjectAgents(path.join(wt, 'nada')), []);
});
