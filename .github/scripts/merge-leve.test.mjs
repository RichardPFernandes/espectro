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
    changed_files: 1,
    ...o,
});
// Check run do GitHub Actions, no formato da API (id crescente por disparo).
const ACTIONS = { id: 15368, slug: 'github-actions' };
const cr = (id, name, status, conclusion, o = {}) => ({ id, name, status, conclusion, app: ACTIONS, ...o });
const green = () => ({
    checkRuns: [
        cr(101, 'Node 22', 'completed', 'success'),
        cr(102, 'Node 24', 'completed', 'success'),
        cr(103, 'processo-check', 'completed', 'success'),
        cr(104, 'Static checks', 'completed', 'neutral'),
    ],
    statuses: [],
});
// O PR falso traz changed_files coerente com a lista de arquivos do caso.
const run = (o = {}) => {
    const files = o.files ?? [file('docs/x.md')];
    return evaluatePr({ pr: pr({ changed_files: files.length }), files, checks: green(), config, repo: REPO, ...o });
};

test('config: mergeLeve traz a lista da SPEC e os checks obrigatórios', () => {
    assert.deepEqual(cfg.requiredChecks, ['Node 22', 'Node 24', 'processo-check']);
    assert.deepEqual(cfg.removableExtensions, ['.md']);
    for (const p of ['ROADMAP.md', 'README.md', 'roadmap/**/*.md', 'docs/**/*.md', 'tasks/**/*.md', 'scripts/**/*.test.js', 'dashboard/**/*.test.js']) {
        assert.ok(cfg.allowedPaths.includes(p), p);
    }
    for (const p of ['.github/**', '.claude/**', '**/CLAUDE.md', '**/CLAUDE.local.md', '**/AGENTS.md', '**/.*/**',
        'docs/capacidades/**', 'docs/flags.md', 'docs/handoff-contract.md', 'docs/migrations/**', 'templates/**',
        '**/fixtures/**', '**/package*.json']) {
        assert.ok(cfg.deniedPaths.includes(p), p);
    }
    for (const p of ['**/*.test.js', '**/*.test.mjs']) assert.ok(!cfg.allowedPaths.includes(p), p);
});

// D-PRI-410-02 (Richard, 18/11): governança aprovada fica com o Richard;
// teste só elegível em scripts/ e dashboard/.
test('SPEC, plan, todo já aprovados e roadmap/DECISOES.md → negados', () => {
    for (const f of ['tasks/f0-8-x/SPEC.md', 'tasks/pri-1/SPEC-c1-mapa.md', 'tasks/pri-1/plan.md', 'tasks/f0-8-x/todo.md', 'roadmap/DECISOES.md']) {
        const v = pathVerdict([file(f)], cfg);
        assert.equal(v.ok, false, f);
        assert.match(v.motivos.join('\n'), /negado/, f);
    }
    assert.equal(pathVerdict([file('tasks/pri-1/notas.md')], cfg).ok, true);
});

test('teste fora de scripts/ e dashboard/ → fora da lista', () => {
    for (const f of ['docs/x.test.js', 'harness/a.test.js', 'tools/a.test.mjs', 'scripts/lib/a.test.mjs']) {
        assert.equal(pathVerdict([file(f)], cfg).ok, false, f);
    }
    assert.equal(pathVerdict([file('scripts/lib/a.test.js'), file('dashboard/lib/b.test.js')], cfg).ok, true);
});

test('só docs/x.md → elegível', () => {
    assert.deepEqual(pathVerdict([file('docs/x.md')], cfg), { ok: true, motivos: [] });
    const r = run();
    assert.equal(r.merge, true, r.motivos.join('; '));
    assert.deepEqual(r.motivos, []);
});

test('teste e markdown da lista → elegível', () => {
    const v = pathVerdict([file('ROADMAP.md'), file('roadmap/f0/FASE.md'), file('tasks/pri-1/notas.md'), file('scripts/lib/a.test.js'), file('.github/../x.test.mjs')], cfg);
    // `.github/../x.test.mjs` não é normalizado: começa por `.github/`, então é negado.
    assert.equal(v.ok, false);
    assert.equal(pathVerdict([file('ROADMAP.md'), file('roadmap/f0/FASE.md'), file('tasks/pri-1/notas.md'), file('scripts/lib/a.test.js')], cfg).ok, true);
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

// O Claude Code carrega CLAUDE.md, AGENTS.md e diretórios .claude/ de qualquer
// subpasta; um diretório de ponto em qualquer nível também é negado.
for (const f of ['docs/CLAUDE.md', 'tasks/pri-1/CLAUDE.md', 'roadmap/CLAUDE.local.md', 'docs/AGENTS.md',
    'docs/.claude/skills/x/SKILL.md', 'tasks/.github/x.md', 'CLAUDE.local.md']) {
    test(`${f} negado em qualquer profundidade`, () => {
        const v = pathVerdict([file(f)], cfg);
        assert.equal(v.ok, false, f);
        assert.match(v.motivos.join('\n'), /caminho negado/, f);
    });
}

test('docs/x.md continua elegível com as negações novas', () => {
    assert.deepEqual(pathVerdict([file('docs/x.md'), file('docs/a.b/c.md'), file('tasks/pri-1/notas.claude.md')], cfg), { ok: true, motivos: [] });
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
    checks.checkRuns[0] = cr(101, 'Node 22', 'in_progress', null);
    const r = run({ checks });
    assert.equal(r.merge, false);
    assert.match(r.motivos.join('\n'), /Node 22/);
});

test('check vermelho → não mescla, mesmo fora dos obrigatórios (AC-05)', () => {
    const checks = green();
    checks.checkRuns[3] = cr(104, 'Static checks', 'completed', 'failure');
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
    checks.checkRuns.push(cr(105, 'opcional', 'completed', 'skipped'));
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
    const raw = pr({ changed_files: files.length, mergeLeve: head.mergeLeve, config: head, files: [file('docs/x.md')] });
    const spy = new Proxy(raw, { get(t, k) { read.add(k); return Reflect.get(t, k); } });

    const r = evaluatePr({ pr: spy, files, checks: green(), config: base, repo: REPO });

    assert.equal(r.merge, false);
    const m = r.motivos.join('\n');
    assert.match(m, /tasks\/x\.json/);
    assert.match(m, /docs\/novo\/a\.json/);
    assert.match(m, /\.github\/processo\.json/);
    for (const k of ['mergeLeve', 'config', 'files']) assert.ok(!read.has(k), `leu pr.${String(k)}`);
});

// A: cada disparo do processo-check cria um check suite novo; as execuções
// antigas ficam na lista mesmo com filter=latest. Vale a mais recente por nome.
test('check cancelado antigo + success novo com o mesmo nome → mescla', () => {
    const checks = green();
    checks.checkRuns.push(cr(90, 'processo-check', 'completed', 'cancelled'));
    const r = run({ checks });
    assert.equal(r.merge, true, r.motivos.join('; '));
});

test('check success antigo + in_progress novo com o mesmo nome → não mescla', () => {
    const checks = green();
    checks.checkRuns.push(cr(200, 'processo-check', 'in_progress', null));
    const r = run({ checks });
    assert.equal(r.merge, false);
    assert.match(r.motivos.join('\n'), /check pendente: processo-check/);
});

test('check success antigo + failure novo com o mesmo nome → não mescla', () => {
    const checks = green();
    checks.checkRuns.push(cr(200, 'Node 22', 'completed', 'failure'));
    const r = run({ checks });
    assert.equal(r.merge, false);
    assert.match(r.motivos.join('\n'), /check sem sucesso: Node 22/);
});

test('mesmo id ou sem id: desempata pelo started_at', () => {
    const checks = green();
    checks.checkRuns = checks.checkRuns.map(({ id, ...c }) => ({ ...c, started_at: '2026-11-18T10:00:00Z' }));
    checks.checkRuns.push({ ...cr(undefined, 'Node 24', 'completed', 'failure'), started_at: '2026-11-18T09:00:00Z' });
    assert.equal(run({ checks }).merge, true, 'failure mais antigo fica de fora');
    checks.checkRuns.push({ ...cr(undefined, 'Node 24', 'completed', 'failure'), started_at: '2026-11-18T11:00:00Z' });
    assert.equal(run({ checks }).merge, false, 'failure mais novo vale');
});

test('check de outro app com o mesmo nome, falhado e mais antigo, não some atrás do success do Actions', () => {
    const checks = green();
    checks.checkRuns.push(cr(50, 'Node 22', 'completed', 'failure', { app: { id: 999, slug: 'outro-app' } }));
    const r = run({ checks });
    assert.equal(r.merge, false);
    assert.match(r.motivos.join('\n'), /check sem sucesso: Node 22 \(failure\)/);
});

// B: presença dos requiredChecks só conta check run do GitHub Actions.
test('status success com o nome de um check obrigatório, sem check run → não mescla', () => {
    const checks = green();
    checks.checkRuns = checks.checkRuns.filter((c) => c.name !== 'Node 22');
    checks.statuses = [{ context: 'Node 22', state: 'success' }];
    const r = run({ checks });
    assert.equal(r.merge, false);
    assert.match(r.motivos.join('\n'), /check obrigatório ausente: Node 22/);
});

test('check run obrigatório criado por outro app → não mescla', () => {
    const checks = green();
    checks.checkRuns[0] = cr(101, 'Node 22', 'completed', 'success', { app: { id: 999, slug: 'outro-app' } });
    const r = run({ checks });
    assert.equal(r.merge, false);
    assert.match(r.motivos.join('\n'), /check obrigatório ausente: Node 22/);
    // Sem app nenhum também não conta.
    checks.checkRuns[0] = cr(101, 'Node 22', 'completed', 'success', { app: undefined });
    assert.equal(run({ checks }).merge, false);
});

test('check run do Actions reconhecido só pelo slug ou só pelo id', () => {
    const checks = green();
    checks.checkRuns[0] = cr(101, 'Node 22', 'completed', 'success', { app: { slug: 'github-actions' } });
    checks.checkRuns[1] = cr(102, 'Node 24', 'completed', 'success', { app: { id: 15368 } });
    assert.equal(run({ checks }).merge, true);
});

// C: a API de arquivos do PR para em 3000; lista diferente de changed_files
// não é a lista inteira.
test('changed_files ausente → não mescla, lista incompleta', () => {
    const r = run({ pr: pr({ changed_files: undefined }) });
    assert.equal(r.merge, false);
    assert.match(r.motivos.join('\n'), /lista de arquivos incompleta \(1 de undefined\)/);
});

test('menos arquivos que changed_files → não mescla, lista incompleta', () => {
    const r = run({ pr: pr({ changed_files: 2 }) });
    assert.equal(r.merge, false);
    assert.match(r.motivos.join('\n'), /lista de arquivos incompleta \(1 de 2\)/);
});

test('3000 arquivos ou mais → não mescla, mesmo com changed_files igual', () => {
    const files = Array.from({ length: 3000 }, (_, i) => file(`docs/d${i}.md`));
    const r = run({ files, pr: pr({ changed_files: 3000 }) });
    assert.equal(r.merge, false);
    assert.match(r.motivos.join('\n'), /lista de arquivos incompleta \(3000 de 3000\)/);
    assert.equal(run({ files: files.slice(0, 2999), pr: pr({ changed_files: 2999 }) }).merge, true);
});
