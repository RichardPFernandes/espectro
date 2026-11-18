// node --test .github/scripts/merge-leve.test.mjs
// Elegibilidade do merge automático do Leve (F0.8, PRI-410; AC-01, AC-02, AC-05).
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePr, pathVerdict, loadConfig } from './merge-leve-lib.mjs';

const config = loadConfig();
const cfg = config.mergeLeve;
const REPO = 'dono/prisma';
const SHA = 'a'.repeat(40);

const file = (filename, status = 'modified', previous_filename) => (
    previous_filename ? { filename, status, previous_filename } : { filename, status });
const pr = (o = {}) => ({
    number: 7,
    state: 'open',
    draft: false,
    labels: [{ name: 'processo:leve' }],
    head: { sha: SHA, repo: { full_name: REPO } },
    base: { ref: 'main', repo: { full_name: REPO } },
    ...o,
});
const green = () => ({
    checkRuns: [
        { name: 'Node 22', status: 'completed', conclusion: 'success' },
        { name: 'Node 24', status: 'completed', conclusion: 'success' },
        { name: 'processo-check', status: 'completed', conclusion: 'success' },
        { name: 'Static checks', status: 'completed', conclusion: 'neutral' },
    ],
    statuses: [],
});
const run = (o = {}) => evaluatePr({ pr: pr(), files: [file('docs/x.md')], checks: green(), config, repo: REPO, ...o });

test('config: mergeLeve traz a lista da SPEC e os checks obrigatórios', () => {
    assert.deepEqual(cfg.requiredChecks, ['Node 22', 'Node 24', 'processo-check']);
    assert.deepEqual(cfg.removableExtensions, ['.md']);
    for (const p of ['ROADMAP.md', 'README.md', 'roadmap/**/*.md', 'docs/**/*.md', 'tasks/**/*.md', '**/*.test.js', '**/*.test.mjs']) {
        assert.ok(cfg.allowedPaths.includes(p), p);
    }
    for (const p of ['.github/**', '.claude/**', 'CLAUDE.md', 'AGENTS.md', 'docs/capacidades/**', 'docs/flags.md',
        'docs/handoff-contract.md', 'docs/migrations/**', 'templates/**', '**/fixtures/**', '**/package*.json']) {
        assert.ok(cfg.deniedPaths.includes(p), p);
    }
});

test('só docs/x.md → elegível', () => {
    assert.deepEqual(pathVerdict([file('docs/x.md')], cfg), { ok: true, motivos: [] });
    const r = run();
    assert.equal(r.merge, true, r.motivos.join('; '));
    assert.deepEqual(r.motivos, []);
});

test('teste e markdown da lista → elegível', () => {
    const v = pathVerdict([file('ROADMAP.md'), file('roadmap/f0/FASE.md'), file('tasks/pri-1/plan.md'), file('scripts/lib/a.test.js'), file('.github/../x.test.mjs')], cfg);
    // `.github/../x.test.mjs` não é normalizado: começa por `.github/`, então é negado.
    assert.equal(v.ok, false);
    assert.equal(pathVerdict([file('ROADMAP.md'), file('roadmap/f0/FASE.md'), file('tasks/pri-1/plan.md'), file('scripts/lib/a.test.js')], cfg).ok, true);
});

test('scripts/a.js fora da lista → não mescla (AC-02)', () => {
    const r = run({ files: [file('docs/x.md'), file('scripts/a.js')] });
    assert.equal(r.merge, false);
    assert.match(r.motivos.join('\n'), /scripts\/a\.js/);
});

test('docs/flags.md e .github/processo.json negados, mesmo casando a permissão', () => {
    for (const f of ['docs/flags.md', '.github/processo.json', 'docs/capacidades/x.md', 'docs/migrations/a.md', '.claude/skills/a/x.test.mjs', 'scripts/fixtures/a.test.js']) {
        const v = pathVerdict([file(f)], cfg);
        assert.equal(v.ok, false, f);
        assert.match(v.motivos.join('\n'), /negado/, f);
    }
});

test('CLAUDE.md e AGENTS.md na raiz negados', () => {
    assert.equal(pathVerdict([file('CLAUDE.md')], cfg).ok, false);
    assert.equal(pathVerdict([file('AGENTS.md')], cfg).ok, false);
});

test('teste removido → fora (apagar teste fica com o Richard)', () => {
    const v = pathVerdict([file('scripts/lib/a.test.js', 'removed')], cfg);
    assert.equal(v.ok, false);
    assert.match(v.motivos.join('\n'), /removido/);
});

test('.md removido → ok', () => {
    assert.equal(pathVerdict([file('docs/velho.md', 'removed')], cfg).ok, true);
});

test('.md renomeado dentro da lista → ok; nome antigo fora da lista → fora', () => {
    assert.equal(pathVerdict([file('docs/novo.md', 'renamed', 'docs/velho.md')], cfg).ok, true);
    const v = pathVerdict([file('docs/novo.md', 'renamed', 'CLAUDE.md')], cfg);
    assert.equal(v.ok, false);
    assert.match(v.motivos.join('\n'), /CLAUDE\.md/);
    assert.equal(pathVerdict([file('docs/novo.md', 'renamed', 'scripts/a.md')], cfg).ok, false);
});

test('teste renomeado → fora (só .md renomeia)', () => {
    const v = pathVerdict([file('scripts/b.test.js', 'renamed', 'scripts/a.test.js')], cfg);
    assert.equal(v.ok, false);
    assert.match(v.motivos.join('\n'), /renomeado/);
});

test('PR sem arquivos → fora', () => {
    assert.equal(pathVerdict([], cfg).ok, false);
});

test('draft → não mescla (AC-05)', () => {
    const r = run({ pr: pr({ draft: true }) });
    assert.equal(r.merge, false);
    assert.match(r.motivos.join('\n'), /draft/);
});

test('fork → não mescla (AC-05)', () => {
    const r = run({ pr: pr({ head: { sha: SHA, repo: { full_name: 'outro/prisma' } } }) });
    assert.equal(r.merge, false);
    assert.match(r.motivos.join('\n'), /fork/);
    // Repositório de origem apagado (head.repo null) também é fora.
    assert.equal(run({ pr: pr({ head: { sha: SHA, repo: null } }) }).merge, false);
});

test('base fora da main ou PR fechado → não mescla', () => {
    assert.equal(run({ pr: pr({ base: { ref: 'outra', repo: { full_name: REPO } } }) }).merge, false);
    assert.equal(run({ pr: pr({ state: 'closed' }) }).merge, false);
});

test('check pendente → não mescla (AC-05)', () => {
    const checks = green();
    checks.checkRuns[0] = { name: 'Node 22', status: 'in_progress', conclusion: null };
    const r = run({ checks });
    assert.equal(r.merge, false);
    assert.match(r.motivos.join('\n'), /Node 22/);
});

test('check vermelho → não mescla, mesmo fora dos obrigatórios (AC-05)', () => {
    const checks = green();
    checks.checkRuns[3] = { name: 'Static checks', status: 'completed', conclusion: 'failure' };
    const r = run({ checks });
    assert.equal(r.merge, false);
    assert.match(r.motivos.join('\n'), /Static checks/);
});

test('status (API de statuses) pendente ou com erro → não mescla', () => {
    for (const state of ['pending', 'failure', 'error']) {
        const checks = green();
        checks.statuses = [{ context: 'ci/externo', state }];
        assert.equal(run({ checks }).merge, false, state);
    }
    const ok = green();
    ok.statuses = [{ context: 'ci/externo', state: 'success' }];
    assert.equal(run({ checks: ok }).merge, true);
});

test('check skipped → aceito', () => {
    const checks = green();
    checks.checkRuns.push({ name: 'opcional', status: 'completed', conclusion: 'skipped' });
    assert.equal(run({ checks }).merge, true);
});

test('check obrigatório ausente → não mescla (AC-05)', () => {
    const checks = green();
    checks.checkRuns = checks.checkRuns.filter((c) => c.name !== 'processo-check');
    const r = run({ checks });
    assert.equal(r.merge, false);
    assert.match(r.motivos.join('\n'), /processo-check/);
});

test('dois rótulos de nível → não mescla (AC-05)', () => {
    const r = run({ pr: pr({ labels: [{ name: 'processo:leve' }, { name: 'processo:alto' }] }) });
    assert.equal(r.merge, false);
    assert.match(r.motivos.join('\n'), /rótulo/);
});

test('sem rótulo de nível ou com nível diferente de leve → não mescla', () => {
    assert.equal(run({ pr: pr({ labels: [] }) }).merge, false);
    assert.equal(run({ pr: pr({ labels: [{ name: 'processo:medio' }] }) }).merge, false);
    // Rótulos do GitHub não diferenciam maiúsculas; string ou objeto.
    assert.equal(run({ pr: pr({ labels: ['Processo:Leve', { name: 'docs' }] }) }).merge, true);
});

test('config sem mergeLeve → não mescla', () => {
    const r = run({ config: { levels: config.levels } });
    assert.equal(r.merge, false);
});

test('AC-01: vale a lista da base, não a que o PR acrescenta', () => {
    // A base não admite docs/novo/** fora de markdown nem tasks/*.json.
    const base = structuredClone(config);
    assert.ok(!base.mergeLeve.allowedPaths.includes('docs/novo/**'));
    // O head do PR acrescenta docs/novo/** e tasks/** à própria lista.
    const head = structuredClone(config);
    head.mergeLeve.allowedPaths.push('docs/novo/**', 'tasks/**');
    head.mergeLeve.deniedPaths = [];
    const files = [file('.github/processo.json'), file('docs/novo/a.json'), file('tasks/x.json')];
    // O PR leva a lista do head junto; a função precisa ignorá-la.
    const read = new Set();
    const raw = pr({ mergeLeve: head.mergeLeve, config: head, files: [file('docs/x.md')] });
    const spy = new Proxy(raw, { get(t, k) { read.add(k); return Reflect.get(t, k); } });

    const r = evaluatePr({ pr: spy, files, checks: green(), config: base, repo: REPO });

    assert.equal(r.merge, false);
    const m = r.motivos.join('\n');
    assert.match(m, /tasks\/x\.json/);
    assert.match(m, /docs\/novo\/a\.json/);
    assert.match(m, /\.github\/processo\.json/);
    for (const k of ['mergeLeve', 'config', 'files']) assert.ok(!read.has(k), `leu pr.${String(k)}`);
});
