// node --test .github/scripts/estado-no-merge.test.mjs
// CLI do estado no merge (F0.9 AC-02) com Linear e GitHub falsos que registram as chamadas.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run } from './estado-no-merge.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = 'acme/prisma';
const DONE_ID = 'st-done';

const DESC = [
    '**Estado:** em revisão.',
    '**Próximo passo:** mesclar o PR.',
    '**Decisão pendente:** nenhuma.',
    '',
    'Corpo da issue.',
].join('\n');

function issue(identifier, over = {}) {
    return {
        id: `uuid-${identifier}`,
        identifier,
        description: DESC,
        state: { type: 'started', name: 'In Progress' },
        team: { states: [
            { id: 'st-prog', name: 'In Progress', type: 'started' },
            { id: 'st-other', name: 'Released', type: 'completed' },
            { id: DONE_ID, name: 'Done', type: 'completed' },
        ] },
        children: [],
        attachments: [],
        ...over,
    };
}

function pull(over = {}) {
    return {
        number: 50, state: 'closed', merged: true, merged_at: '2026-11-17T22:10:00Z',
        title: 'feat: x (Refs PRI-1)', body: '', labels: [{ name: 'processo:medio' }], ...over,
    };
}

// Falsos: registram cada chamada; `issues`/`pulls` são mapas; função no lugar do valor lança.
function fakes({ issues = {}, pulls = {} } = {}) {
    const calls = { linear: [], gh: [], mutations: [] };
    const linear = {
        async getIssue(id) {
            calls.linear.push(['getIssue', id]);
            const v = issues[id];
            if (typeof v === 'function') return v();
            if (!v) throw new Error(`issue ${id} não encontrada`);
            return v;
        },
        async updateIssue(id, input) {
            calls.linear.push(['updateIssue', id]);
            calls.mutations.push({ id, input });
            return true;
        },
    };
    const gh = {
        async getPull(n) {
            calls.gh.push(['getPull', n]);
            if (!pulls[n]) throw new Error(`PR ${n} não encontrado`);
            return pulls[n];
        },
    };
    return { calls, linear, gh };
}

async function exec({ mode, event, issues, pulls, env = {} }) {
    const f = fakes({ issues, pulls });
    const out = [];
    const code = await run({
        env: { GITHUB_REPOSITORY: REPO, ...(mode === undefined ? {} : { ESTADO_NO_MERGE: mode }), ...env },
        event,
        linear: f.linear,
        gh: f.gh,
        summary: (t) => out.push(t),
        now: () => new Date('2026-11-18T12:00:00Z'),
    });
    return { code, calls: f.calls, summary: out.join('\n') };
}

test('variável ausente ou off: sai 0 sem chamar Linear nem GitHub', async () => {
    for (const mode of [undefined, 'off', '']) {
        const r = await exec({ mode, event: { pull_request: pull() }, issues: { 'PRI-1': issue('PRI-1') } });
        assert.equal(r.code, 0);
        assert.deepEqual(r.calls.linear, []);
        assert.deepEqual(r.calls.gh, []);
    }
});

test('simular: só leituras, e o resumo diz o que faria', async () => {
    const r = await exec({ mode: 'simular', event: { pull_request: pull() }, issues: { 'PRI-1': issue('PRI-1') } });
    assert.equal(r.code, 0);
    assert.deepEqual(r.calls.mutations, []);
    assert.deepEqual(r.calls.linear, [['getIssue', 'PRI-1']]);
    assert.match(r.summary, /simular/);
    assert.match(r.summary, /PRI-1.*done/);
    assert.match(r.summary, /não escrito/);
});

test('on + Médio limpo: uma mutação com stateId do Done e descrição nova', async () => {
    const r = await exec({ mode: 'on', event: { pull_request: pull() }, issues: { 'PRI-1': issue('PRI-1') } });
    assert.equal(r.code, 0);
    assert.equal(r.calls.mutations.length, 1);
    const { id, input } = r.calls.mutations[0];
    assert.equal(id, 'uuid-PRI-1');
    assert.equal(input.stateId, DONE_ID);
    assert.match(input.description, /^\*\*Estado:\*\* PR #50 mesclado em 2026-11-17; issue em Done pela Action\.$/m);
    assert.match(input.description, /^\*\*Próximo passo:\*\* nenhum\.$/m);
    assert.match(input.description, /^\*\*Decisão pendente:\*\* nenhuma\.$/m);
    assert.match(r.summary, /escrito/);
});

test('on + Alto: zero mutações', async () => {
    const r = await exec({ mode: 'on', event: { pull_request: pull({ labels: [{ name: 'processo:alto' }] }) }, issues: { 'PRI-1': issue('PRI-1') } });
    assert.equal(r.code, 0);
    assert.deepEqual(r.calls.mutations, []);
    assert.match(r.summary, /alto/);
});

test('on + filha aberta: mutação só com descrição, sem stateId', async () => {
    const children = [
        { identifier: 'PRI-2', state: { type: 'started' } },
        { identifier: 'PRI-3', state: { type: 'completed' } },
        { identifier: 'PRI-4', state: { type: 'canceled' } },
    ];
    const r = await exec({ mode: 'on', event: { pull_request: pull() }, issues: { 'PRI-1': issue('PRI-1', { children }) } });
    assert.equal(r.code, 0);
    assert.equal(r.calls.mutations.length, 1);
    const { input } = r.calls.mutations[0];
    assert.equal('stateId' in input, false);
    assert.match(input.description, /^\*\*Próximo passo:\*\* falta filha PRI-2\.$/m);
});

test('on + outro PR aberto anexado: conta só PR deste repo, diferente do mesclado e aberto', async () => {
    const attachments = [
        { url: `https://github.com/${REPO}/pull/50` },
        { url: `https://github.com/${REPO}/pull/51` },
        { url: `https://github.com/${REPO}/pull/52#issuecomment-1` },
        { url: 'https://github.com/outro/repo/pull/53' },
        { url: 'https://linear.app/x' },
    ];
    const pulls = { 51: pull({ number: 51, state: 'open', merged: false }), 52: pull({ number: 52, state: 'closed' }) };
    const r = await exec({ mode: 'on', event: { pull_request: pull() }, issues: { 'PRI-1': issue('PRI-1', { attachments }) }, pulls });
    assert.equal(r.code, 0);
    assert.deepEqual(r.calls.gh.map((c) => c[1]).sort(), [51, 52]);
    assert.equal(r.calls.mutations.length, 1);
    assert.equal('stateId' in r.calls.mutations[0].input, false);
    assert.match(r.calls.mutations[0].input.description, /falta PR #51\./);
});

test('PR fechado sem merge: nada', async () => {
    const r = await exec({ mode: 'on', event: { pull_request: pull({ merged: false, merged_at: null }) }, issues: { 'PRI-1': issue('PRI-1') } });
    assert.equal(r.code, 0);
    assert.deepEqual(r.calls.linear, []);
    assert.match(r.summary, /não mesclado/);
});

test('erro do Linear numa issue: a outra ainda é processada e o código é 1', async () => {
    const issues = {
        'PRI-1': () => { throw new Error('Linear API 500'); },
        'PRI-2': issue('PRI-2'),
    };
    const event = { pull_request: pull({ title: 'feat: x (Refs PRI-1)', body: 'Refs PRI-2' }) };
    const r = await exec({ mode: 'on', event, issues });
    assert.equal(r.code, 1);
    assert.equal(r.calls.mutations.length, 1);
    assert.equal(r.calls.mutations[0].id, 'uuid-PRI-2');
    assert.match(r.summary, /PRI-1.*Linear API 500/);
});

test('dispatch: busca o PR pelo número do input', async () => {
    const r = await exec({ mode: 'simular', event: { inputs: { pr: '50' } }, issues: { 'PRI-1': issue('PRI-1') }, pulls: { 50: pull() } });
    assert.equal(r.code, 0);
    assert.deepEqual(r.calls.gh, [['getPull', 50]]);
    assert.match(r.summary, /PRI-1.*done/);
});

test('issue já em Done: não move de novo, só reescreve a descrição', async () => {
    const r = await exec({ mode: 'on', event: { pull_request: pull() }, issues: { 'PRI-1': issue('PRI-1', { state: { type: 'completed', name: 'Done' } }) } });
    assert.equal(r.calls.mutations.length, 1);
    assert.equal('stateId' in r.calls.mutations[0].input, false);
    assert.ok(r.calls.mutations[0].input.description);
});

test('issue cancelada: nada', async () => {
    const r = await exec({ mode: 'on', event: { pull_request: pull() }, issues: { 'PRI-1': issue('PRI-1', { state: { type: 'canceled', name: 'Canceled' } }) } });
    assert.equal(r.code, 0);
    assert.deepEqual(r.calls.mutations, []);
    assert.match(r.summary, /cancelada/);
});

test('sem linha de Estado: ainda move para Done, sem descrição, e o resumo avisa', async () => {
    const r = await exec({ mode: 'on', event: { pull_request: pull() }, issues: { 'PRI-1': issue('PRI-1', { description: 'sem bloco' }) } });
    assert.equal(r.calls.mutations.length, 1);
    assert.deepEqual(r.calls.mutations[0].input, { stateId: DONE_ID });
    assert.match(r.summary, /linhas não achadas: Estado, Próximo passo/);
});

test('time sem estado Done: erro na issue, código 1, sem mutação', async () => {
    const team = { states: [{ id: 'st-other', name: 'Released', type: 'completed' }] };
    const r = await exec({ mode: 'on', event: { pull_request: pull() }, issues: { 'PRI-1': issue('PRI-1', { team }) } });
    assert.equal(r.code, 1);
    assert.deepEqual(r.calls.mutations, []);
});

test('o valor dos tokens nunca aparece no resumo, mesmo em mensagem de erro', async () => {
    const issues = { 'PRI-1': () => { throw new Error('falhou com lin_api_SEGREDO e ghs_TOKEN'); } };
    const r = await exec({ mode: 'on', event: { pull_request: pull() }, issues, env: { LINEAR_API_KEY: 'lin_api_SEGREDO', GITHUB_TOKEN: 'ghs_TOKEN' } });
    assert.equal(r.code, 1);
    assert.doesNotMatch(r.summary, /lin_api_SEGREDO|ghs_TOKEN/);
});

test('CLI com --fake e o evento de exemplo, em simular: imprime a decisão sem rede', () => {
    const fixtures = path.join(HERE, 'fixtures');
    const res = spawnSync(process.execPath, [
        path.join(HERE, 'estado-no-merge.mjs'),
        '--event', path.join(fixtures, 'estado-no-merge-event.json'),
        '--fake', path.join(fixtures, 'estado-no-merge-fake.json'),
    ], { encoding: 'utf8', env: { PATH: process.env.PATH, ESTADO_NO_MERGE: 'simular', GITHUB_REPOSITORY: 'acme/prisma' } });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /PRI-399.*done/);
    assert.match(res.stdout, /PRI-400.*estado/);
    assert.match(fs.readFileSync(path.join(fixtures, 'estado-no-merge-fake.json'), 'utf8'), /PRI-399/);
});
