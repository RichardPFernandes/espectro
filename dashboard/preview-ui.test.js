// node --test preview-ui.test.js
// Fonte do preview no painel (public/preview.js > PreviewSource): worktree × commit,
// lista de commits da branch do ticket e o que está no ar. Só HTML gerado e regras.
const test = require('node:test');
const assert = require('node:assert');
const PS = require('./public/preview');

const st = (over = {}) => ({ phase: 'idle', worktrees: { back: true }, branches: { back: 'origin/4242', front: 'origin/4242' }, ...over });
const SHA1 = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const SHA2 = 'ffeeddccbbaa99887766554433221100ffeeddcc';
const commits = { data: { ref: 'origin/4242', sha: SHA1, front: { ref: 'origin/4242', sha: SHA2 }, commits: [
    { sha: SHA1, date: '2026-11-10T12:00:00-03:00', subject: 'segundo <b>do</b> ticket' },
    { sha: SHA2, date: '2026-11-09T12:00:00-03:00', subject: 'primeiro' },
] } };

test('defaultSource: worktree quando existe; sem worktree e com branch, commit; sem nenhum, worktree', () => {
    assert.strictEqual(PS.defaultSource(st()), 'worktree');
    assert.strictEqual(PS.defaultSource(st({ worktrees: { back: false } })), 'commit');
    assert.strictEqual(PS.defaultSource(st({ worktrees: { back: false }, branches: { back: null } })), 'worktree');
});

test('sourceHtml: grupo rotulado com aria-pressed na fonte escolhida; fonte indisponível desabilitada com o motivo', () => {
    const html = PS.sourceHtml(st({ worktrees: { back: false } }), 'commit', false);
    assert.match(html, /role="group" aria-label="Fonte do código"/);
    assert.match(html, /data-pvsrc="commit" aria-pressed="true"/);
    assert.match(html, /data-pvsrc="worktree" aria-pressed="false" disabled title="worktree não encontrado"/);
    const semBranch = PS.sourceHtml(st({ branches: { back: null } }), 'worktree', false);
    assert.match(semBranch, /data-pvsrc="commit" aria-pressed="false" disabled title="sem branch do ticket no app-back"/);
    assert.match(PS.sourceHtml(st(), 'worktree', true), /data-pvsrc="worktree" aria-pressed="true" disabled/);
});

test('commitPickerHtml: carregando, erro com tentar de novo, vazio e lista (SHA curto, assunto escapado, ponta do front)', () => {
    assert.match(PS.commitPickerHtml({ loading: true }, null, false), /Buscando commits/);
    const err = PS.commitPickerHtml({ error: 'git <falhou>' }, null, false);
    assert.match(err, /git &lt;falhou&gt;/);
    assert.match(err, /data-pvcommitsload/);
    assert.match(PS.commitPickerHtml({ data: { ref: 'origin/4242', commits: [], front: null } }, null, false), /Nenhum commit/);

    const html = PS.commitPickerHtml(commits, SHA2, false);
    assert.match(html, /<label[^>]*>Commit de origin\/4242/);
    assert.match(html, new RegExp(`<option value="${SHA1}" >a1b2c3d4 · segundo &lt;b&gt;do&lt;/b&gt; ticket`));
    assert.match(html, new RegExp(`<option value="${SHA2}" selected>ffeeddcc · primeiro`));
    assert.match(html, /mais recente/);
    assert.match(html, /front: origin\/4242 @ ffeeddcc \(ponta\)/);
    assert.match(PS.commitPickerHtml({ data: { ...commits.data, front: null } }, null, false), /front: sem branch do ticket — sobe só o back/);
});

test('startBody/canStart: worktree pede o worktree; commit pede a lista carregada e manda o SHA escolhido (ou o mais recente)', () => {
    assert.strictEqual(PS.canStart(st(), 'worktree', {}), true);
    assert.strictEqual(PS.canStart(st({ worktrees: { back: false } }), 'worktree', {}), false);
    assert.strictEqual(PS.canStart(st(), 'commit', { loading: true }), false);
    assert.strictEqual(PS.canStart(st(), 'commit', commits), true);
    assert.strictEqual(PS.canStart(st(), 'commit', { data: { ...commits.data, commits: [] } }), false);
    assert.deepStrictEqual(PS.startBody('worktree', commits, SHA2), { source: 'worktree' });
    assert.deepStrictEqual(PS.startBody('commit', commits, SHA2), { source: 'commit', commit: SHA2 });
    assert.deepStrictEqual(PS.startBody('commit', commits, 'sumiu'), { source: 'commit', commit: SHA1 });
});

test('liveSourceText: o que está no ar no modo commit (back e front); worktree diz worktree', () => {
    assert.strictEqual(PS.liveSourceText({ source: 'worktree' }), 'worktree do ticket');
    assert.strictEqual(PS.liveSourceText({ source: 'commit', commit: { ref: 'origin/4242', sha: SHA1 }, refs: { front: { ref: 'origin/4242', sha: SHA2 } } }),
        'commit a1b2c3d4 de origin/4242 · front ffeeddcc');
    assert.strictEqual(PS.liveSourceText({ source: 'commit', commit: { ref: 'origin/4242', sha: SHA1 }, refs: {} }), 'commit a1b2c3d4 de origin/4242');
    assert.strictEqual(PS.liveSourceText({}), '');
});
