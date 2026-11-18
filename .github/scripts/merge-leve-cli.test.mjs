// node --test .github/scripts/merge-leve-cli.test.mjs
// CLI do merge automático do Leve (F0.8, PRI-410; AC-04, AC-01, AC-02), com um
// `gh` falso que registra as chamadas: nenhuma rede.
import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from './merge-leve.mjs';
import { loadConfig } from './merge-leve-lib.mjs';

const config = loadConfig();
const REPO = 'dono/prisma';
const SHA = 'b'.repeat(40);

const prJson = (o = {}) => ({
    number: 7,
    state: 'open',
    draft: false,
    labels: [{ name: 'processo:leve' }],
    head: { sha: SHA, repo: { full_name: REPO } },
    base: { ref: 'main', repo: { full_name: REPO } },
    ...o,
});
const greenRuns = () => [
    { name: 'Node 22', status: 'completed', conclusion: 'success' },
    { name: 'Node 24', status: 'completed', conclusion: 'success' },
    { name: 'processo-check', status: 'completed', conclusion: 'success' },
];
const event = (pullRequests = [{ number: 7 }]) => ({
    workflow_run: { event: 'pull_request', head_sha: SHA, pull_requests: pullRequests },
});

// gh(method, path, body) falso. `files` é paginado como a API (100 por página).
function fakeGh({ pr = prJson(), files = [{ filename: 'docs/x.md', status: 'modified' }], checkRuns = greenRuns(),
    statuses = [], pulls = [], mergeError } = {}) {
    const calls = [];
    const gh = async (method, url, body) => {
        calls.push({ method, url, body });
        const [p, q = ''] = url.split('?');
        const params = new URLSearchParams(q);
        const page = Number(params.get('page') ?? 1);
        const per = Number(params.get('per_page') ?? 30);
        const slice = (list) => list.slice((page - 1) * per, page * per);
        if (method === 'GET' && p === `/repos/${REPO}/pulls/7`) return pr;
        if (method === 'GET' && p === `/repos/${REPO}/pulls/7/files`) return slice(files);
        if (method === 'GET' && p === `/repos/${REPO}/commits/${SHA}/check-runs`) return { total_count: checkRuns.length, check_runs: slice(checkRuns) };
        if (method === 'GET' && p === `/repos/${REPO}/commits/${SHA}/status`) return { state: 'success', total_count: statuses.length, statuses: slice(statuses) };
        if (method === 'GET' && p === `/repos/${REPO}/commits/${SHA}/pulls`) return pulls;
        if (method === 'PUT' && p === `/repos/${REPO}/pulls/7/merge`) {
            if (mergeError) throw Object.assign(new Error(`GitHub API ${mergeError}`), { status: mergeError });
            return { merged: true, sha: 'c'.repeat(40) };
        }
        if (method === 'POST' && p === `/repos/${REPO}/actions/workflows/roadmap-pages.yml/dispatches`) return null;
        throw new Error(`chamada inesperada: ${method} ${url}`);
    };
    return { gh, calls };
}

async function exec({ env = {}, ev = event(), cfg = config, ...fake } = {}) {
    const { gh, calls } = fakeGh(fake);
    const out = [];
    const logs = [];
    await run({ event: ev, env: { GITHUB_REPOSITORY: REPO, ...env }, gh, config: cfg, log: (l) => logs.push(l), summary: (t) => out.push(t) });
    const writes = calls.filter((c) => c.method !== 'GET');
    return { calls, writes, summary: out.join(''), logs: logs.join('\n') };
}

test('sem MERGE_LEVE, PR elegível: nenhum PUT e o resumo diz "mesclaria" (AC-04)', async () => {
    const r = await exec();
    assert.deepEqual(r.writes, []);
    assert.match(r.summary, /mesclaria #7/);
});

test('MERGE_LEVE diferente de "on" só simula (AC-04)', async () => {
    for (const v of ['off', 'ON', 'true', '1', '']) {
        const r = await exec({ env: { MERGE_LEVE: v } });
        assert.deepEqual(r.writes, [], `MERGE_LEVE=${v}`);
        assert.match(r.summary, /mesclaria #7/, `MERGE_LEVE=${v}`);
    }
});

test('MERGE_LEVE=on e elegível: um PUT de squash com o sha avaliado', async () => {
    const r = await exec({ env: { MERGE_LEVE: 'on' } });
    assert.deepEqual(r.writes, [
        { method: 'PUT', url: `/repos/${REPO}/pulls/7/merge`, body: { merge_method: 'squash', sha: SHA } },
    ]);
    assert.match(r.summary, /mesclado #7/);
});

test('PR com scripts/ não gera PUT nem com MERGE_LEVE=on, e o resumo traz o motivo (AC-02)', async () => {
    const r = await exec({ env: { MERGE_LEVE: 'on' }, files: [{ filename: 'docs/x.md', status: 'modified' }, { filename: 'scripts/a.js', status: 'modified' }] });
    assert.deepEqual(r.writes, []);
    assert.match(r.summary, /não #7: .*scripts\/a\.js: fora da lista mergeLeve/);
});

test('arquivos paginados: caminho proibido na segunda página impede o merge (AC-02)', async () => {
    const files = Array.from({ length: 100 }, (_, i) => ({ filename: `docs/d${i}.md`, status: 'modified' }));
    files.push({ filename: 'scripts/a.js', status: 'modified' });
    const r = await exec({ env: { MERGE_LEVE: 'on' }, files });
    assert.deepEqual(r.writes, []);
    assert.match(r.summary, /scripts\/a\.js/);
});

test('check-runs paginados: check vermelho na segunda página impede o merge', async () => {
    const checkRuns = [...greenRuns(), ...Array.from({ length: 100 }, (_, i) => ({ name: `extra ${i}`, status: 'completed', conclusion: 'success' }))];
    checkRuns.push({ name: 'Static checks', status: 'completed', conclusion: 'failure' });
    const r = await exec({ env: { MERGE_LEVE: 'on' }, checkRuns });
    assert.deepEqual(r.writes, []);
    assert.match(r.summary, /Static checks/);
});

test('a lista vem do config recebido (checkout da main), nunca do PR (AC-01)', async () => {
    const base = structuredClone(config);
    base.mergeLeve.allowedPaths = base.mergeLeve.allowedPaths.filter((p) => p !== 'docs/**/*.md');
    const r = await exec({ env: { MERGE_LEVE: 'on' }, cfg: base });
    assert.deepEqual(r.writes, []);
    assert.match(r.summary, /não #7: .*docs\/x\.md: fora da lista mergeLeve/);
    assert.ok(!r.calls.some((c) => c.url.includes('/contents/')), 'não lê arquivo nenhum do PR');
});

test('409 e 405 no merge ficam para a próxima rodada, sem erro', async () => {
    for (const status of [409, 405]) {
        const r = await exec({ env: { MERGE_LEVE: 'on' }, mergeError: status });
        assert.match(r.summary, /#7 mudou, fica para a próxima rodada/);
        assert.ok(!r.writes.some((c) => c.method === 'POST'));
    }
});

test('outro erro no merge não é engolido', async () => {
    await assert.rejects(exec({ env: { MERGE_LEVE: 'on' }, mergeError: 500 }), /500/);
});

test('merge que toca roadmap dispara o roadmap-pages na main', async () => {
    for (const filename of ['ROADMAP.md', 'roadmap/fase-0-destravar/FASE.md']) {
        const r = await exec({ env: { MERGE_LEVE: 'on' }, files: [{ filename, status: 'modified' }] });
        assert.deepEqual(r.writes.at(-1), {
            method: 'POST', url: `/repos/${REPO}/actions/workflows/roadmap-pages.yml/dispatches`, body: { ref: 'main' },
        }, filename);
    }
});

test('merge só de docs não dispara o roadmap-pages', async () => {
    const r = await exec({ env: { MERGE_LEVE: 'on' } });
    assert.ok(!r.writes.some((c) => c.method === 'POST'));
});

test('simulação com roadmap não dispara nada', async () => {
    const r = await exec({ files: [{ filename: 'ROADMAP.md', status: 'modified' }] });
    assert.deepEqual(r.writes, []);
});

test('sem pull_requests no evento, busca os PRs pelo head_sha e pula os fechados', async () => {
    const pulls = [{ number: 7, state: 'open' }, { number: 8, state: 'closed' }];
    const r = await exec({ ev: event([]), pulls });
    assert.ok(r.calls.some((c) => c.url === `/repos/${REPO}/commits/${SHA}/pulls`));
    assert.ok(!r.calls.some((c) => c.url.startsWith(`/repos/${REPO}/pulls/8`)));
    assert.match(r.summary, /mesclaria #7/);
});

test('sem PR nenhum, só registra no resumo', async () => {
    const r = await exec({ ev: event([]), pulls: [] });
    assert.deepEqual(r.writes, []);
    assert.match(r.summary, /nenhum PR/);
});

test('o que vem do PR é escapado: nome de arquivo com quebra de linha não forja linha no resumo', async () => {
    const r = await exec({ files: [{ filename: 'scripts/a\n- mesclaria #99\r.js', status: 'modified' }] });
    assert.doesNotMatch(r.summary, /^- mesclaria #99/m);
    assert.doesNotMatch(r.summary, /mesclaria #7/);
    assert.match(r.summary, /scripts\/a%0A- mesclaria #99%0D\.js/);
    assert.doesNotMatch(r.logs, /^- mesclaria #99/m);
});
