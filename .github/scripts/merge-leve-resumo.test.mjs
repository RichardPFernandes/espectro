// node --test .github/scripts/merge-leve-resumo.test.mjs
// Resumo diário do merge automático do Leve na issue fixa (F0.8, PRI-410;
// AC-03), com um `gh` falso que registra as chamadas: nenhuma rede.
import test from 'node:test';
import assert from 'node:assert/strict';
import { run, ISSUE_TITLE } from './merge-leve-resumo.mjs';
import { buildDailySummary, loadConfig } from './merge-leve-lib.mjs';

const config = loadConfig();
const REPO = 'dono/prisma';
const NOW = new Date('2026-11-18T11:00:00Z');
const HOURS_AGO = (h) => new Date(NOW.getTime() - h * 3600e3).toISOString();
const BOT = 'github-actions[bot]';

const closedPr = (number, title, mergedBy, mergedHoursAgo = 3) => ({
    number,
    title,
    state: 'closed',
    merged_at: mergedHoursAgo == null ? null : HOURS_AGO(mergedHoursAgo),
    updated_at: HOURS_AGO(mergedHoursAgo ?? 2),
    merged_by: mergedBy ? { login: mergedBy } : null,
});
const openPr = (number, title, o = {}) => ({
    number,
    title,
    state: 'open',
    draft: false,
    labels: [{ name: 'processo:leve' }],
    head: { sha: String(number).repeat(40).slice(0, 40), repo: { full_name: REPO } },
    base: { ref: 'main', repo: { full_name: REPO } },
    ...o,
});
const greenRuns = () => [
    { name: 'Node 22', status: 'completed', conclusion: 'success' },
    { name: 'Node 24', status: 'completed', conclusion: 'success' },
    { name: 'processo-check', status: 'completed', conclusion: 'success' },
];

// gh(method, path, body) falso. Listas paginadas como a API (per_page/page).
function fakeGh({ closed = [], open = [], files = {}, issues = [] } = {}) {
    const calls = [];
    let nextIssue = 900;
    const gh = async (method, url, body) => {
        calls.push({ method, url, body });
        const [p, q = ''] = url.split('?');
        const params = new URLSearchParams(q);
        const page = Number(params.get('page') ?? 1);
        const per = Number(params.get('per_page') ?? 30);
        const slice = (list) => list.slice((page - 1) * per, page * per);
        if (method === 'GET' && p === `/repos/${REPO}/pulls`) {
            return slice(params.get('state') === 'closed' ? closed.map(({ merged_by, ...rest }) => rest) : open);
        }
        let m = p.match(new RegExp(`^/repos/${REPO}/pulls/(\\d+)$`));
        if (method === 'GET' && m) {
            const n = Number(m[1]);
            const pr = [...closed, ...open].find((x) => x.number === n);
            if (!pr) throw Object.assign(new Error('404'), { status: 404 });
            return pr;
        }
        m = p.match(new RegExp(`^/repos/${REPO}/pulls/(\\d+)/files$`));
        if (method === 'GET' && m) return slice(files[m[1]] ?? [{ filename: 'docs/x.md', status: 'modified' }]);
        m = p.match(new RegExp(`^/repos/${REPO}/commits/([0-9a-f]+)/check-runs$`));
        if (method === 'GET' && m) return { total_count: 3, check_runs: slice(greenRuns()) };
        m = p.match(new RegExp(`^/repos/${REPO}/commits/([0-9a-f]+)/status$`));
        if (method === 'GET' && m) return { state: 'success', total_count: 0, statuses: [] };
        if (method === 'GET' && p === `/repos/${REPO}/issues`) return slice(issues);
        if (method === 'POST' && p === `/repos/${REPO}/issues`) {
            const created = { number: nextIssue++, title: body.title, state: 'open' };
            issues.push(created);
            return created;
        }
        m = p.match(new RegExp(`^/repos/${REPO}/issues/(\\d+)/comments$`));
        if (method === 'POST' && m) return { id: 1, html_url: `https://github.com/${REPO}/issues/${m[1]}#c1` };
        throw new Error(`chamada inesperada: ${method} ${url}`);
    };
    return { gh, calls };
}

async function exec(fake = {}, env = {}) {
    const { gh, calls } = fakeGh(fake);
    const result = await run({ env: { GITHUB_REPOSITORY: REPO, ...env }, gh, config, now: NOW, log: () => {} });
    const writes = calls.filter((c) => c.method !== 'GET');
    const comments = writes.filter((c) => /\/issues\/\d+\/comments$/.test(c.url));
    return { calls, writes, comments, result };
}

const FIXED = { number: 50, title: ISSUE_TITLE, state: 'open' };

test('PR mesclado pelo bot aparece no comentário, com número, título e issue', async () => {
    const r = await exec({ closed: [closedPr(11, 'docs: ajusta guia (Refs PRI-123)', BOT)], issues: [FIXED] });
    assert.equal(r.comments.length, 1);
    assert.equal(r.comments[0].url, `/repos/${REPO}/issues/50/comments`);
    const body = r.comments[0].body.body;
    assert.match(body, /#11/);
    assert.match(body, /ajusta guia/);
    assert.match(body, /PRI-123/);
});

test('PR mesclado por outra pessoa não aparece', async () => {
    const r = await exec({
        closed: [closedPr(11, 'docs: do bot (Refs PRI-1)', BOT), closedPr(12, 'docs: do Richard (Refs PRI-2)', 'RichardPFernandes')],
        issues: [FIXED],
    });
    assert.equal(r.comments.length, 1);
    const body = r.comments[0].body.body;
    assert.match(body, /#11/);
    assert.doesNotMatch(body, /#12/);
    assert.doesNotMatch(body, /do Richard/);
});

test('PR fechado sem merge ou mesclado há mais de 24 h não aparece', async () => {
    const r = await exec({
        closed: [closedPr(13, 'docs: fechado', null, null), closedPr(14, 'docs: antigo', BOT, 30)],
        issues: [FIXED],
    });
    assert.deepEqual(r.writes, []);
});

test('dia vazio não comenta nem cria issue', async () => {
    const r = await exec({ issues: [] });
    assert.deepEqual(r.writes, []);
    assert.equal(buildDailySummary({ merged: [], skipped: [], date: '2026-11-18' }), null);
});

test('sem a issue fixa, ela é criada uma vez e recebe o comentário', async () => {
    const issues = [{ number: 3, title: 'outra', state: 'open' }, { number: 4, title: `${ISSUE_TITLE} (velha)`, state: 'open' }];
    const fake = { closed: [closedPr(11, 'docs: x (Refs PRI-9)', BOT)], issues };
    const r = await exec(fake);
    const creates = r.writes.filter((c) => c.method === 'POST' && c.url === `/repos/${REPO}/issues`);
    assert.equal(creates.length, 1);
    assert.equal(creates[0].body.title, ISSUE_TITLE);
    assert.equal(r.comments.length, 1);
    assert.equal(r.comments[0].url, `/repos/${REPO}/issues/900/comments`);

    // Na rodada seguinte a issue já existe: comenta nela, sem criar outra.
    const again = await exec(fake);
    assert.equal(again.writes.filter((c) => c.url === `/repos/${REPO}/issues`).length, 0);
    assert.equal(again.comments[0].url, `/repos/${REPO}/issues/900/comments`);
});

test('PR (não issue) com o título exato não conta como a issue fixa', async () => {
    const issues = [{ number: 5, title: ISSUE_TITLE, state: 'open', pull_request: { url: 'x' } }];
    const r = await exec({ closed: [closedPr(11, 'docs: x', BOT)], issues });
    assert.equal(r.writes.filter((c) => c.url === `/repos/${REPO}/issues`).length, 1);
});

test('Leve fora da lista aparece em "ficou de fora" com o motivo', async () => {
    const r = await exec({
        open: [
            openPr(21, 'feat: mexe em script (Refs PRI-7)'),
            openPr(22, 'docs: elegível'),
            openPr(23, 'docs: em draft', { draft: true }),
            openPr(24, 'feat: médio', { labels: [{ name: 'processo:medio' }] }),
        ],
        files: { 21: [{ filename: 'scripts/a.js', status: 'modified' }] },
        issues: [FIXED],
    });
    assert.equal(r.comments.length, 1);
    const body = r.comments[0].body.body;
    assert.match(body, /ficou de fora/i);
    assert.match(body, /#21/);
    assert.match(body, /scripts\/a\.js: fora da lista mergeLeve/);
    for (const n of ['#22', '#23', '#24']) assert.ok(!body.includes(n), n);
});

test('o que vem do PR é escapado no markdown', async () => {
    const r = await exec({
        closed: [closedPr(11, 'docs: [link](http://x) @alguem <b>x</b>\n## falso', BOT)],
        open: [openPr(21, 'feat: y')],
        files: { 21: [{ filename: 'scripts/*a*_[b].js', status: 'modified' }] },
        issues: [FIXED],
    });
    const body = r.comments[0].body.body;
    assert.ok(!body.includes('[link](http://x)'), 'link cru');
    assert.ok(!body.includes('<b>'), 'html cru');
    assert.ok(!/(^|\s)@alguem/.test(body), 'menção crua');
    assert.ok(!/\n## falso/.test(body), 'quebra de linha crua');
    assert.ok(!body.includes('*a*_[b]'), 'nome de arquivo cru');
});

test('não lê MERGE_LEVE: o resultado é o mesmo com on ou sem', async () => {
    const fake = () => ({ closed: [closedPr(11, 'docs: x', BOT)], issues: [{ ...FIXED }] });
    const a = await exec(fake(), {});
    const b = await exec(fake(), { MERGE_LEVE: 'on' });
    assert.deepEqual(a.writes, b.writes);
    assert.ok(a.writes.every((c) => c.method === 'POST' && /\/issues(\/\d+\/comments)?$/.test(c.url)));
});
