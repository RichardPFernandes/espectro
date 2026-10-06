const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { Readable } = require('stream');
const { REDACTED, buildSanitizer, createSanitizingStream, createLinePrefixStream } = require('./sanitize-log');

// Valores fictícios — nunca usar token real em teste.
const FAKE_BB = 'ATATTfake0000000000000000000000bitbucket';
const FAKE_RM = 'feedfacefeedfacefeedfacefeedfacefeedface';
const SCRIPT = path.join(__dirname, 'sanitize-log.js');
const silent = { onWarning: () => {} };

async function collect(readable) {
    let out = '';
    for await (const chunk of readable) out += chunk;
    return out;
}

test('redige os secrets conhecidos, preserva o resto', () => {
    const sanitize = buildSanitizer({ BITBUCKET_API_TOKEN: FAKE_BB, REDMINE_API_KEY: FAKE_RM }, silent);
    assert.strictEqual(
        sanitize(`Authorization: Bearer ${FAKE_BB} key=${FAKE_RM} fim`),
        `Authorization: Bearer ${REDACTED} key=${REDACTED} fim`,
    );
    assert.strictEqual(sanitize('sem secret nenhum'), 'sem secret nenhum');
});

test('sem secrets no env: devolve a string intacta', () => {
    const sanitize = buildSanitizer({}, silent);
    assert.strictEqual(sanitize('qualquer coisa'), 'qualquer coisa');
    assert.strictEqual(sanitize.maxSecretLength, 0);
});

test('pega secret fora da lista por padrão de nome (*_TOKEN, *_API_KEY, ...)', () => {
    const sanitize = buildSanitizer({ OUTRA_API_KEY: 'abcdefghijklmnop', HOME: '/Users/alguem' }, silent);
    assert.strictEqual(sanitize('x abcdefghijklmnop y /Users/alguem'), `x ${REDACTED} y /Users/alguem`);
});

test('secret curto (< 8): avisa sem mostrar o valor e não bloqueia', () => {
    const warnings = [];
    const sanitize = buildSanitizer({ REDMINE_API_KEY: 'x7q2', BITBUCKET_API_TOKEN: FAKE_BB }, { onWarning: m => warnings.push(m) });
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /REDMINE_API_KEY muito curto/);
    assert.ok(!warnings[0].includes('x7q2'), 'aviso não pode exibir o valor');
    assert.strictEqual(sanitize(`x7q2 ${FAKE_BB}`), `x7q2 ${REDACTED}`);
});

test('stream: secret partido entre chunks ainda é redigido', async () => {
    const sanitize = buildSanitizer({ BITBUCKET_API_TOKEN: FAKE_BB }, silent);
    const text = `inicio ${FAKE_BB} meio ${FAKE_BB}\nfim`;
    // Um caractere por chunk: pior caso de fronteira.
    const chunks = [...text].map(c => Buffer.from(c));
    const out = await collect(Readable.from(chunks).pipe(createSanitizingStream(sanitize)));
    assert.strictEqual(out, `inicio ${REDACTED} meio ${REDACTED}\nfim`);
});

test('stream: UTF-8 multibyte partido entre chunks não corrompe', async () => {
    const sanitize = buildSanitizer({ BITBUCKET_API_TOKEN: FAKE_BB }, silent);
    const buf = Buffer.from(`ação ${FAKE_BB} ✓`);
    const chunks = [...buf].map(b => Buffer.from([b]));
    const out = await collect(Readable.from(chunks).pipe(createSanitizingStream(sanitize)));
    assert.strictEqual(out, `ação ${REDACTED} ✓`);
});

test('createLinePrefixStream: prefixa cada linha completa com timestamp ISO', async () => {
    const out = await collect(Readable.from(['linha um\nlinha dois\n']).pipe(createLinePrefixStream('[claude]')));
    const lines = out.trim().split('\n');
    assert.strictEqual(lines.length, 2);
    assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[claude\] linha um$/);
    assert.match(lines[1], /^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[claude\] linha dois$/);
});

test('createLinePrefixStream: linha final sem \\n ainda sai prefixada (flush)', async () => {
    const out = await collect(Readable.from(['sem quebra no fim']).pipe(createLinePrefixStream('[watcher]')));
    assert.match(out, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[watcher\] sem quebra no fim\n$/);
});

test('createLinePrefixStream depois de createSanitizingStream: secret partido entre chunks continua redigido', async () => {
    const sanitize = buildSanitizer({ BITBUCKET_API_TOKEN: FAKE_BB }, silent);
    const chunks = [`token=${FAKE_BB.slice(0, 10)}`, `${FAKE_BB.slice(10)} no meio\n`];
    const out = await collect(
        Readable.from(chunks).pipe(createSanitizingStream(sanitize)).pipe(createLinePrefixStream('[claude]')),
    );
    assert.ok(!out.includes(FAKE_BB), 'token vazou depois do prefixo de linha');
    assert.match(out, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[claude\] token=\[REDACTED\] no meio\n$/);
});

test('CLI: filtro stdin -> stdout usa os secrets do env e prefixa [claude]', () => {
    const r = spawnSync(process.execPath, [SCRIPT], {
        input: `token=${FAKE_BB}\n`,
        env: { PATH: process.env.PATH, BITBUCKET_API_TOKEN: FAKE_BB },
        encoding: 'utf8',
    });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stderr, '');
    // Linha filtrada pelo modo detached de spawnAgent (readmine-watcher.js) ganha
    // timestamp ISO + prefixo [claude] — ver createLinePrefixStream.
    assert.match(r.stdout, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[claude\] token=\[REDACTED\]\n$/);
    assert.ok(!r.stdout.includes(FAKE_BB), 'token vazou no stdout do CLI');
});

// Reproduz a fiação do readmine-watcher.js sem --follow: filtro detached escrevendo
// no log, agente detached escrevendo no stdin do filtro, e o pai (watcher) indo
// embora antes do agente terminar de imprimir.
test('fiação sem --follow: token impresso pelo filho sai [REDACTED] no log', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sanitize-log-'));
    const logPath = path.join(dir, 'agent.log');
    const parent = `
        const fs = require('fs');
        const { spawn } = require('child_process');
        const env = { PATH: process.env.PATH, BITBUCKET_API_TOKEN: ${JSON.stringify(FAKE_BB)} };
        const logFd = fs.openSync(${JSON.stringify(logPath)}, 'a');
        const filter = spawn(process.execPath, [${JSON.stringify(SCRIPT)}], { env, detached: true, stdio: ['pipe', logFd, logFd] });
        filter.unref();
        const child = spawn('/bin/sh', ['-c', 'sleep 0.3; echo "out $BITBUCKET_API_TOKEN"; echo "err $BITBUCKET_API_TOKEN" >&2'],
            { env, detached: true, stdio: ['ignore', filter.stdin, filter.stdin] });
        filter.stdin.destroy();
        fs.closeSync(logFd);
        child.unref();
    `;
    const r = spawnSync(process.execPath, ['-e', parent], { encoding: 'utf8', timeout: 5000 });
    assert.strictEqual(r.status, 0, r.stderr);
    // Pai já saiu; espera o filho + filtro terminarem de escrever.
    const deadline = Date.now() + 5000;
    let log = '';
    while (Date.now() < deadline) {
        log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
        if (log.includes('out ') && log.includes('err ')) break;
        await new Promise(res => setTimeout(res, 50));
    }
    fs.rmSync(dir, { recursive: true, force: true });
    assert.ok(!log.includes(FAKE_BB), 'token vazou no log');
    assert.match(log, /out \[REDACTED\]/);
    assert.match(log, /err \[REDACTED\]/);
});
