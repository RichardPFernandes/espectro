// node --test onboarding-ui.test.js
// Tela "Este computador" (public/onboarding.js, artboard ThisComputer): partes puras que
// decidem o que cada linha, etapa e campo mostra.
const test = require('node:test');
const assert = require('node:assert');
const O = require('./public/onboarding');

test('stepsModel: etapa atual, feitas com ✓ e subtítulos do artboard', () => {
    const s = O.stepsModel(2);
    assert.deepStrictEqual(s.map(p => p.mark), ['✓', '2', '3']);
    assert.deepStrictEqual(s.map(p => p.current), [false, true, false]);
    assert.deepStrictEqual(s.map(p => p.sub), ['ferramentas desta máquina', 'pasta, conta e integrações', 'testes só de leitura']);
});

test('toolRow: pronta mostra versão e uso; ausente mostra o pedido do servidor e o comando', () => {
    const ok = O.toolRow({ id: 'git', name: 'Git', requirement: 'obrigatório', version: 'git 2.47.1', state: 'done', detail: 'encontrado · 2.47.1' });
    assert.deepStrictEqual([ok.glyph, ok.tone, ok.ver, ok.req], ['✓', 'ok', 'git 2.47.1', 'obrigatório']);
    assert.match(ok.note, /worktrees/);
    const miss = O.toolRow({ id: 'claude', name: 'Claude Code', requirement: 'obrigatório', version: null, state: 'waiting',
        detail: 'Não encontrado. Instale e faça login no terminal:', command: 'npm install -g @anthropic-ai/claude-code && claude' });
    assert.deepStrictEqual([miss.glyph, miss.tone, miss.ver], ['✕', 'no', 'não encontrado']);
    assert.match(miss.note, /^Não encontrado/);
    assert.match(miss.command, /claude-code/);
    const node = O.toolRow({ id: 'node', state: 'waiting', version: 'node 18.2.0', detail: 'v18.2.0 · exige 20 ou mais.', hint: 'Instale o Node 20.' });
    assert.strictEqual(node.ver, 'node 18.2.0');
    assert.strictEqual(node.note, 'v18.2.0 · exige 20 ou mais. Instale o Node 20.');
    const codex = O.toolRow({ id: 'codex', name: 'Codex', requirement: 'opcional', version: null, state: 'queued', detail: 'não encontrado' });
    assert.deepStrictEqual([codex.glyph, codex.tone, codex.command, codex.ver], ['○', 'opt', '', 'não encontrado']);
    // Opcional ausente: nota e comando de instalação do artboard (o comando vem do servidor).
    assert.strictEqual(codex.note, 'Só faz falta se algum nó do fluxo usar Codex.');
    assert.strictEqual(O.toolRow({ id: 'codex', state: 'queued', command: 'npm install -g @openai/codex' }).command, 'npm install -g @openai/codex');
    assert.strictEqual(O.toolRow({ id: 'codex', state: 'done', version: 'codex 0.48.0' }).note, 'O watcher ainda despacha só Claude Code.');
    // respondeu sem número de versão: nunca "não encontrado" ao lado de um ✓
    assert.strictEqual(O.toolRow({ id: 'claude', state: 'done', version: null }).ver, 'versão desconhecida');
});

test('checkRows: ordem e nomes do artboard; sem resultado nada é inventado', () => {
    const none = O.checkRows(null);
    assert.deepStrictEqual(none.map(r => r.name), ['Repositório', 'Redmine', 'Bitbucket', 'Contrato de configuração', 'Claude']);
    assert.ok(none.every(r => r.tone === 'opt' && r.note === 'não testado'));
    assert.ok(O.checkRows(null, { checking: true }).every(r => r.glyph === '◐' && r.note === 'testando…'));
    const rows = O.checkRows([
        { id: 'agent', state: 'done', detail: 'respondeu ao ensaio · conta padrão' },
        { id: 'repo', state: 'failed', detail: 'git status falhou' },
        { id: 'project', state: 'queued', detail: 'depende do repositório' },
    ]);
    assert.deepStrictEqual(rows.map(r => r.id), ['repo', 'redmine', 'bitbucket', 'project', 'agent']);
    assert.deepStrictEqual([rows[0].glyph, rows[0].note], ['✕', 'git status falhou']);
    assert.deepStrictEqual([rows[4].glyph, rows[4].tone], ['✓', 'ok']);
});

test('joinRepo/splitRepo: um campo workspace/repo para as duas chaves do servidor', () => {
    assert.strictEqual(O.joinRepo('acme', 'app-back'), 'acme/app-back');
    assert.strictEqual(O.joinRepo('acme', ''), 'acme');
    assert.strictEqual(O.joinRepo('', 'app'), '/app');
    assert.strictEqual(O.joinRepo('', ''), '');
    assert.deepStrictEqual(O.splitRepo(' acme/app-back '), { ok: true, workspace: 'acme', repoSlug: 'app-back' });
    assert.deepStrictEqual(O.splitRepo(''), { ok: true, workspace: '', repoSlug: '' });
    // só workspace (o .env pode ter só ele): continua salvável, sem travar o formulário
    assert.deepStrictEqual(O.splitRepo('acme'), { ok: true, workspace: 'acme', repoSlug: '' });
    for (const [ws, slug] of [['acme', 'app'], ['acme', ''], ['', 'app']]) {
        const back = O.splitRepo(O.joinRepo(ws, slug));
        assert.deepStrictEqual([back.workspace, back.repoSlug], [ws, slug]);
    }
    for (const bad of ['acme/', 'a/b/c', 'a b/c']) assert.strictEqual(O.splitRepo(bad).ok, false, bad);
});

test('mapFieldErrors: erro de workspace ou slug do servidor volta para o campo único', () => {
    assert.deepStrictEqual(O.mapFieldErrors({ bitbucketRepoSlug: 'Só letras…', redmineUrl: 'x' }), { bitbucketRepo: 'Só letras…', redmineUrl: 'x' });
    assert.deepStrictEqual(O.mapFieldErrors({ bitbucketWorkspace: 'w' }), { bitbucketRepo: 'w' });
    assert.deepStrictEqual(O.mapFieldErrors(undefined), {});
    // valor que passa no cliente e o SLUG_RE do servidor recusa: o erro do servidor é que manda
    assert.strictEqual(O.splitRepo('ac!me/app').ok, true);
});

test('formFromConfig: espelha o gravado e nunca traz segredo', () => {
    const f = O.formFromConfig({ repo: { path: '/r' }, agent: { account: 'default' }, redmine: { url: 'https://rm', apiKeySet: true },
        bitbucket: { workspace: 'acme', repoSlug: 'app', apiTokenSet: true } });
    assert.deepStrictEqual(f, { repoPath: '/r', claudeAccount: 'default', redmineUrl: 'https://rm', redmineApiKey: '', bitbucketRepo: 'acme/app', bitbucketApiToken: '' });
});

test('secretPlaceholder e pathNote: só referência ao segredo; nota da pasta', () => {
    assert.strictEqual(O.secretPlaceholder(true, 'salva'), 'salva · deixe em branco para manter');
    assert.strictEqual(O.secretPlaceholder(false), 'não preenchido');
    assert.match(O.pathNote(null).text, /^Repositório onde o watcher/);
    assert.deepStrictEqual(O.pathNote({ ok: false, reason: 'Não é um repositório Git.' }), { text: '✕ Não é um repositório Git.', tone: 'no' });
    assert.strictEqual(O.pathNote({ ok: true }, { value: '/a', active: '/a' }).text, '✓ Repositório Git.');
    assert.strictEqual(O.pathNote({ ok: true }, { value: '/b', active: '/a' }).text, '✓ Repositório Git. Vale depois de reiniciar.');
    assert.strictEqual(O.pathNote({ ok: true }, { value: '/a/', active: '/a' }).text, '✓ Repositório Git.');
    assert.match(O.pathNote(null, { locked: true }).text, /launcher do projeto \(REPO_PATH/);
});

test('option: conta padrão e conta extra como no artboard', () => {
    assert.strictEqual(O.option({ id: 'default', label: 'padrão' }), '~/.claude · padrão');
    assert.strictEqual(O.option({ id: '~/.claude-trabalho', label: 'trabalho' }), '~/.claude-trabalho · trabalho');
});
