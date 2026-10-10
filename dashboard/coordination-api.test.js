const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { WebSocket } = require('ws');
const { createDashboard } = require('./server');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coordination-api-'));
const statusPath = path.join(tmp, 'status.json');
const capacityScript = path.join(tmp, 'capacity.mjs');
const hits = path.join(tmp, 'hits');
const at = '2026-10-10T15:00:00Z';
const secret = 'restricted-content-never-returned';
fs.writeFileSync(capacityScript, `import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(hits)}, 'hit\\n');
console.log(JSON.stringify([{runtime:'codex', reading:{five_hour:{used:21}, seven_day:{used:42}, secret:'raw-capacity-secret'}}, {runtime:'claude', reading:null}, {runtime:'claude (old)', level:'UNKNOWN', reading:{five_hour:{used:77},seven_day:{used:88}}}]));`);
const env = { COORD_STATUS_PATH: statusPath, COORD_CAPACITY_SCRIPT: capacityScript };
const dash = createDashboard({ memoryDir: path.join(tmp, 'memory', 'runs'), env });
let base;
function fixture() {
    return { schemaVersion: 1, updatedAt: at, ignored: 'unknown-field',
        frentes: [{ id: 'prisma', nome: 'Prisma' }, { id: 'restricted', nome: 'M&O', restricted: true }],
        tarefas: [
            { id: 'PRI-99', frente: 'prisma', tarefa: '<script>not executable</script>', agente: 'Codex', runtime: 'codex', estado: 'Em andamento', nota: 'Implementar', link: 'https://linear.app/prisma-app/issue/PRI-99', atualizado: at, ignored: 'unknown-field' },
            { id: 'private-id', frente: 'restricted', tarefa: 'Nome', estado: 'Na fila', nota: secret, agente: secret, runtime: secret, link: `https://example.com/${secret}`, atualizado: secret },
        ] };
}
const write = source => fs.writeFileSync(statusPath, typeof source === 'string' ? source : JSON.stringify(source));
const read = async () => {
    const res = await fetch(`${base}/api/coordination`);
    assert.equal(res.status, 200);
    return res.json();
};
test.before(async () => {
    await new Promise(resolve => dash.server.listen(0, '127.0.0.1', resolve));
    base = `http://localhost:${dash.server.address().port}`;
    await dash.ready;
});
test.after(async () => { await dash.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
test('missing file: empty; valid capacity has explicit unknown windows and no raw fields', async () => {
    const result = await read();
    assert.equal(result.status, 'empty'); assert.equal(result.updatedAt, null);
    assert.deepEqual(result.tarefas, []);
    assert.deepEqual(result.capacity, { status: 'ok', runtimes: [
        { runtime: 'codex', five_hour: { used: 21 }, seven_day: { used: 42 } },
        { runtime: 'claude', five_hour: null, seven_day: null },
        { runtime: 'claude (old)', five_hour: null, seven_day: null },
    ] });
});
test('ok: validates, counts states, ignores unknown fields, strips restricted metadata', async () => {
    write(fixture());
    const result = await read();
    assert.equal(result.status, 'ok'); assert.equal(result.updatedAt, at);
    assert.deepEqual(result.counts, { 'Em andamento': 1, 'Na fila': 1, 'Aguardando você': 0, 'Concluído': 0, 'Bloqueado': 0 });
    assert.equal(result.frentes[0].restricted, false);
    assert.deepEqual(result.tarefas[1], { frente: 'restricted', tarefa: 'Nome', estado: 'Na fila' });
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.ok(!JSON.stringify(result).includes('unknown-field'));
    assert.equal(result.tarefas[0].tarefa, '<script>not executable</script>');
    assert.equal(fs.readFileSync(hits, 'utf8').trim().split('\n').length, 1, 'capacity cached for at least 30 seconds');
});
test('invalid JSON/schema/references/links never echo invalid content', async () => {
    const cases = [secret, { ...fixture(), schemaVersion: 2 }, { ...fixture(), updatedAt: null }];
    for (const mutate of [
        f => { f.frentes[0].restricted = 'false'; },
        f => { f.tarefas[0].estado = 'UNKNOWN'; },
        f => { f.tarefas[0].frente = 'missing'; },
        f => { f.tarefas[0].link = 'javascript:alert(1)'; },
        f => { delete f.tarefas[0].agente; },
        f => { f.tarefas[1].id = 'PRI-99'; },
    ]) { const f = fixture(); mutate(f); cases.push(f); }
    for (const source of cases) {
        write(source);
        const result = await read();
        assert.equal(result.status, 'invalid'); assert.deepEqual(result.tarefas, []);
        assert.ok(Object.values(result.counts).every(value => value === null));
        assert.equal(result.updatedAt, null); assert.match(result.message, /inválido/);
        assert.ok(!JSON.stringify(result).includes(secret));
    }
});
test('capacity missing/malformed/timeout: unavailable, independently of valid status', async () => {
    write(fixture());
    for (const [name, content] of [['missing', null], ['malformed', "console.log('invalid secret output')"], ['timeout', 'setInterval(() => {}, 1000)']]) {
        const script = path.join(tmp, `${name}.mjs`);
        if (content) fs.writeFileSync(script, content);
        const other = createDashboard({ memoryDir: path.join(tmp, name, 'memory', 'runs'), env: { ...env, COORD_CAPACITY_SCRIPT: script } });
        try {
            await new Promise(resolve => other.server.listen(0, '127.0.0.1', resolve));
            const result = await (await fetch(`http://localhost:${other.server.address().port}/api/coordination`)).json();
            assert.equal(result.status, 'ok'); assert.deepEqual(result.capacity, { status: 'unavailable' });
        } finally { await other.close(); }
    }
});
test('watch: change, atomic replacement, removal and creation broadcast WS refresh; GET rereads', async () => {
    write(fixture());
    const ws = new WebSocket(base.replace('http:', 'ws:'));
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const update = (label, action) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => { ws.off('message', listener); reject(new Error(`coordination_update not received: ${label}`)); }, 5000);
        function listener(message) {
            if (JSON.parse(message).type === 'coordination_update') { clearTimeout(timer); ws.off('message', listener); resolve(); }
        }
        ws.on('message', listener); action();
    });
    try {
        const next = fixture(); next.tarefas[0].estado = 'Concluído';
        await update('change', () => write(next)); assert.equal((await read()).counts['Concluído'], 1);
        next.tarefas[0].estado = 'Bloqueado';
        await update('atomic replacement', () => { const replacement = path.join(tmp, 'replacement.json'); fs.writeFileSync(replacement, JSON.stringify(next)); fs.renameSync(replacement, statusPath); });
        assert.equal((await read()).counts['Bloqueado'], 1);
        await update('remove', () => fs.unlinkSync(statusPath)); assert.equal((await read()).status, 'empty');
        await update('create', () => write(fixture())); assert.equal((await read()).status, 'ok');
    } finally { ws.terminate(); }
});
test('coordination inherits localhost guard and has no write endpoint', async () => {
    assert.equal((await fetch(`${base}/api/coordination`, { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await fetch(`${base}/api/coordination`, { method: 'POST' })).status, 404);
});
// Tiny DOM harness: verifies the data sink and restricted UI without a browser dependency.
test('UI: DOM/textContent, restricted two-column table, unsafe links and UNKNOWN capacity', async () => {
    class Element {
        constructor(tag) { this.tag = tag; this.children = []; this.textContent = ''; this.attributes = {}; }
        append(...children) { this.children.push(...children); }
        setAttribute(k, v) { this.attributes[k] = v; }
        addEventListener() {}
        set innerHTML(_) { throw new Error('innerHTML is forbidden'); }
    }
    const source = fixture();
    // Deliberately feed unsanitized restricted fields to prove the UI defense too.
    source.status = 'ok'; source.counts = { 'Em andamento': 1 }; source.capacity = { status: 'ok', runtimes: [{ runtime: 'claude', five_hour: null, seven_day: { used: 25 } }] };
    source.tarefas[0].link = 'javascript:alert(1)';
    const window = { Views: { refresh() {} } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'public', 'coordination.js'), 'utf8'), {
        window, document: { createElement: tag => new Element(tag), head: new Element('head') }, api: async () => source, URL,
    });
    await window.CoordinationView.load();
    const root = window.CoordinationView.render();
    const all = node => [node, ...node.children.flatMap(all)];
    const nodes = all(root);
    assert.ok(nodes.some(n => n.textContent === '<script>not executable</script>'));
    assert.ok(!nodes.some(n => n.textContent.includes(secret)));
    assert.ok(nodes.some(n => n.textContent.includes('sem medição')));
    assert.ok(!nodes.some(n => n.tag === 'a'));
    const tables = nodes.filter(n => n.tag === 'table');
    const privateTable = all(tables[1]);
    assert.equal(privateTable.filter(n => n.tag === 'th').length, 2);
    assert.equal(privateTable.filter(n => n.tag === 'td').length, 2);
});
