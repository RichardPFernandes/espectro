// node --test scripts/lib/ui-verify-verdict.test.js
// Falso PASSOU é o pior caso: cada dado ausente ou fora de formato tem de reprovar.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { touchesFrontend, verdict, formatReport } = require('./ui-verify-verdict');

const APP = ['http://localhost:3399', 'http://127.0.0.1:3399'];
const okScreen = {
    ac: 'AC-1', url: 'http://localhost:3399/', screenshot: 'a.png', console: [],
    requests: [{ url: '/api/runs', status: 200 }], expected: [{ selector: 'Runs', found: true }],
};
const base = { enabled: true, touchesFrontend: true, requiredAcs: ['AC-1'], exists: () => true, appOrigins: APP };
const run = (screens, extra = {}) => verdict({ ...base, ...extra, findings: { screens } });
const codes = r => r.problems.map(p => p.code);

test('flag off: SKIPPED, nunca PASSOU', () => {
    assert.strictEqual(run([okScreen], { enabled: false }).verdict, 'SKIPPED');
});
test('diff sem frontend ou nenhum AC de UI: N/A', () => {
    assert.strictEqual(run([], { touchesFrontend: false }).verdict, 'N/A');
    assert.strictEqual(run([], { requiredAcs: [] }).verdict, 'N/A');
});
test('tela limpa e AC coberto: PASSOU', () => {
    const r = run([okScreen]);
    assert.strictEqual(r.verdict, 'PASSOU');
    assert.deepStrictEqual(r.problems, []);
});
test('sem tela verificada: FALHOU (UNKNOWN não é PASSOU)', () => {
    assert.deepStrictEqual(codes(run([])), ['NO_EVIDENCE']);
});
test('findings que não é objeto ou sem screens em array: INVALID_FINDINGS', () => {
    for (const f of [null, 'x', {}, { screens: 'abc' }, { screens: [null] }]) {
        const r = verdict({ ...base, findings: f });
        assert.strictEqual(r.verdict, 'FALHOU', JSON.stringify(f));
        assert.ok(codes(r).includes('INVALID_FINDINGS'), JSON.stringify(f));
    }
});
test('cada causa reprova com seu código', () => {
    const cases = [
        [{ console: [{ level: 'error', text: 'boom' }] }, 'CONSOLE_ERROR'],
        [{ requests: [{ url: '/x', status: 500 }] }, 'HTTP_ERROR'],
        [{ requests: [{ url: '/x', status: 404 }] }, 'HTTP_ERROR'],
        [{ expected: [{ selector: 'Botão', found: false }] }, 'ELEMENT_MISSING'],
        [{ screenshot: null }, 'NO_SCREENSHOT'],
    ];
    for (const [patch, code] of cases) assert.deepStrictEqual(codes(run([{ ...okScreen, ...patch }])), [code], code);
});
test('requisição sem status numérico (falha de rede) reprova', () => {
    for (const status of [undefined, null, 0, 'failed', '', NaN]) {
        const r = run([{ ...okScreen, requests: [{ url: '/x', status }] }]);
        assert.deepStrictEqual(codes(r), ['REQUEST_FAILED'], String(status));
    }
    assert.strictEqual(run([{ ...okScreen, requests: [{ url: '/x', status: '200' }] }]).verdict, 'PASSOU', 'string numérica ok');
    assert.deepStrictEqual(codes(run([{ ...okScreen, requests: [{ url: '/x', status: '500' }] }])), ['HTTP_ERROR']);
    assert.strictEqual(run([{ ...okScreen, requests: [{ url: '/x', status: 399 }] }]).verdict, 'PASSOU');
    assert.deepStrictEqual(codes(run([{ ...okScreen, requests: [{ url: '/x', status: 400 }] }])), ['HTTP_ERROR'], '400 reprova (limite exato)');
    for (const status of [true, 200.5, [200], 99, 600, '20', '1e3', {}]) {
        assert.deepStrictEqual(codes(run([{ ...okScreen, requests: [{ url: '/x', status }] }])), ['REQUEST_FAILED'], JSON.stringify(status));
    }
});
test('requests vazio e elemento sem texto não provam nada', () => {
    assert.deepStrictEqual(codes(run([{ ...okScreen, requests: [] }])), ['INCOMPLETE_FINDINGS']);
    for (const sel of ['', '   ', undefined, 5]) {
        assert.deepStrictEqual(codes(run([{ ...okScreen, expected: [{ selector: sel, found: true }] }])), ['INVALID_FINDINGS'], String(sel));
    }
});
test('url da tela precisa ser da origem da verificação', () => {
    assert.deepStrictEqual(codes(run([{ ...okScreen, url: 'https://example.com/' }])), ['INVALID_FINDINGS']);
    assert.deepStrictEqual(codes(run([{ ...okScreen, url: undefined }])), ['INVALID_FINDINGS']);
    assert.strictEqual(run([{ ...okScreen, url: 'http://127.0.0.1:3399/x' }]).verdict, 'PASSOU');
});
test('relatório limitado: veredito sobre tudo, lista cortada com contagem', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ url: `/r${i}`, status: 500 }));
    const r = run([{ ...okScreen, requests: many }]);
    assert.strictEqual(r.verdict, 'FALHOU');
    assert.strictEqual(r.problems.length, 50);
    assert.strictEqual(r.omitted, 450);
    assert.match(formatReport(r), /\+450 problemas omitidos/);
});
test('nível do console: maiúscula conta; ausente ou fora do padrão reprova', () => {
    assert.deepStrictEqual(codes(run([{ ...okScreen, console: [{ level: 'ERROR', text: 'x' }] }])), ['CONSOLE_ERROR']);
    for (const m of [{ text: 'x' }, { type: 'error', text: 'x' }, 'boom']) {
        assert.deepStrictEqual(codes(run([{ ...okScreen, console: [m] }])), ['INVALID_FINDINGS'], JSON.stringify(m));
    }
    assert.strictEqual(run([{ ...okScreen, console: [{ level: 'warning', text: 'x' }] }]).verdict, 'PASSOU');
});
test('elemento esperado: found só vale boolean; lista vazia não prova nada', () => {
    assert.deepStrictEqual(codes(run([{ ...okScreen, expected: [{ selector: 'x', found: 'false' }] }])), ['INVALID_FINDINGS']);
    assert.deepStrictEqual(codes(run([{ ...okScreen, expected: [] }])), ['INCOMPLETE_FINDINGS']);
    assert.deepStrictEqual(codes(run([{ ...okScreen, expected: undefined }])), ['INVALID_FINDINGS']);
    assert.deepStrictEqual(codes(run([{ ...okScreen, console: undefined }])), ['INVALID_FINDINGS']);
    assert.deepStrictEqual(codes(run([{ ...okScreen, requests: undefined }])), ['INVALID_FINDINGS']);
});
test('tela só com screenshot (sem nenhuma checagem) não passa', () => {
    assert.strictEqual(run([{ ac: 'AC-1', url: 'u', screenshot: 'a.png' }]).verdict, 'FALHOU');
});
test('screenshot precisa existir no disco e não pode ser em branco', () => {
    assert.deepStrictEqual(codes(run([okScreen], { exists: () => false })), ['NO_SCREENSHOT']);
    assert.deepStrictEqual(codes(run([{ ...okScreen, screenshot: '   ' }])), ['NO_SCREENSHOT']);
});
test('cada AC de UI da spec precisa de ao menos uma tela', () => {
    const r = run([okScreen], { requiredAcs: ['AC-1', 'AC-2'] });
    assert.deepStrictEqual(r.problems.map(p => `${p.code}:${p.where}`), ['AC_NOT_COVERED:AC-2']);
});
test('tela sem AC reprova (não dá para ligar ao critério)', () => {
    assert.ok(codes(run([{ ...okScreen, ac: undefined }])).includes('INVALID_FINDINGS'));
});
test('várias telas: uma ruim reprova e acumula', () => {
    const r = run([okScreen, { ...okScreen, ac: 'AC-1', requests: [{ url: '/y', status: 500 }], expected: [{ selector: 'z', found: false }] }]);
    assert.deepStrictEqual(codes(r), ['HTTP_ERROR', 'ELEMENT_MISSING']);
});
test('ERR_BLOCKED_BY_CLIENT: só some se a URL é de origem fora da permitida', () => {
    const e = text => run([{ ...okScreen, console: [{ level: 'error', text }] }]);
    assert.strictEqual(e('Failed to load resource: net::ERR_BLOCKED_BY_CLIENT @ https://fonts.googleapis.com/x').verdict, 'PASSOU');
    assert.deepStrictEqual(codes(e('Failed to load resource: net::ERR_BLOCKED_BY_CLIENT @ http://localhost:3334/api/x')), ['CONSOLE_ERROR'], 'outra porta do localhost é bug real');
    assert.deepStrictEqual(codes(e('TypeError: x is not a function ERR_BLOCKED_BY_CLIENT')), ['CONSOLE_ERROR'], 'sem URL: não isenta');
    assert.deepStrictEqual(codes(e('net::ERR_BLOCKED_BY_CLIENT @ http://localhost:3399/api/x')), ['CONSOLE_ERROR'], 'origem do app bloqueada é bug');
    for (const host of ['0.0.0.0:3399', 'localhost.:3399', '127.0.0.2:3399', '[::1]:3399', 'app.localhost:3399', 'intranet.local']) {
        assert.deepStrictEqual(codes(e(`net::ERR_BLOCKED_BY_CLIENT @ http://${host}/api/x`)), ['CONSOLE_ERROR'], host);
    }
    assert.deepStrictEqual(codes(e('net::ERR_BLOCKED_BY_CLIENT https://fonts.googleapis.com/x e http://localhost:3399/api/y')), ['CONSOLE_ERROR'], 'URL externa primeiro, do app depois');
    assert.strictEqual(e('net::ERR_BLOCKED_BY_CLIENT @ https://fonts.gstatic.com/a https://cdn.example.com/b').verdict, 'PASSOU', 'só externos');
});
test('precedência: SKIPPED vence N/A; N/A de frontend vence N/A de AC', () => {
    assert.strictEqual(run([], { enabled: false, touchesFrontend: false }).verdict, 'SKIPPED');
    assert.match(run([], { touchesFrontend: false, requiredAcs: [] }).reason, /frontend/);
});

test('touchesFrontend: globs padrão e personalizados', () => {
    assert.ok(touchesFrontend(['dashboard/public/runs-main.js']));
    assert.ok(!touchesFrontend(['scripts/lib/x.js', 'dashboard/server.js']));
    assert.ok(touchesFrontend(['web/src/a.vue'], ['web/**']));
    assert.ok(!touchesFrontend(['dashboard/public/a.js'], ['web/**']));
    assert.ok(touchesFrontend(['web/a1.js'], ['web/a?.js']), '? casa um caractere');
    assert.ok(!touchesFrontend(['web/a.js'], ['web/a?.js']), '? não é opcional');
    assert.ok(touchesFrontend(['a.js'], ['**/*.js']), '**/ casa a raiz');
    assert.ok(touchesFrontend(['x/y/a.js'], ['**/*.js']));
    assert.ok(touchesFrontend(['web/x.js'], ['./web/**']), './ inicial é ignorado');
    assert.ok(touchesFrontend(['dashboard/public/café.js']), 'nome acentuado');
    assert.ok(touchesFrontend(['web/a (1).js'], ['web/a (1).js']), 'caracteres especiais literais');
});
test('formatReport lista os problemas com AC', () => {
    const r = run([{ ...okScreen, expected: [{ selector: 'Botão', found: false }] }]);
    assert.match(formatReport(r), /Veredito: FALHOU[\s\S]*ELEMENT_MISSING\] AC-1 .*Botão/);
    assert.match(formatReport(run([], { touchesFrontend: false })), /^Veredito: N\/A \(diff sem frontend\)$/);
});

const repo = path.join(__dirname, '../..');
test('tools/playwright-mcp: @playwright/mcp na versão exata, lockfile versionado e coerente com o package.json', () => {
    const dir = path.join(repo, 'tools/playwright-mcp');
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'));
    const v = pkg.dependencies['@playwright/mcp'];
    assert.match(v, /^\d+\.\d+\.\d+$/, 'versão exata: sem ^, ~, latest ou faixa');
    assert.deepStrictEqual(Object.keys(pkg.dependencies), ['@playwright/mcp']);
    assert.strictEqual(lock.lockfileVersion >= 2, true);
    assert.strictEqual(lock.packages['node_modules/@playwright/mcp'].version, v, 'o lockfile resolve a mesma versão');
    assert.deepStrictEqual(Object.keys(lock.packages).sort(), ['', 'node_modules/@playwright/mcp', 'node_modules/playwright', 'node_modules/playwright-core'],
        'dependência nova no lockfile exige revisão deliberada deste teste');
    for (const [name, e] of Object.entries(lock.packages)) if (name) assert.match(e.resolved, /^https:\/\/registry\.npmjs\.org\//, `${name}: origem`);
    for (const [name, e] of Object.entries(lock.packages)) {
        if (!name) continue;
        assert.match(e.integrity || '', /^sha512-/, `${name}: integridade no lockfile`);
        assert.ok(!e.hasInstallScript, `${name}: dependência com script de instalação (o --ignore-scripts não pode quebrá-la em silêncio)`);
    }
});
test('.mcp.json: binário local do lockfile (sem npx), versão exata, perfil em memória, porta validada fora do texto do script, headless por padrão', () => {
    const pw = JSON.parse(fs.readFileSync(path.join(repo, '.mcp.json'), 'utf8')).mcpServers.playwright;
    assert.strictEqual(pw.command, 'sh');
    const script = pw.args[pw.args.indexOf('-c') + 1];
    assert.ok(!/\bnpx\b/.test(script) && !/\bnpm\s+exec\b/.test(script), 'sem npx/npm exec: nada é baixado ao subir o MCP');
    assert.ok(!/@playwright\/mcp/.test(script) && !/@latest/.test(script), 'a versão mora no package.json/lockfile, não no comando');
    assert.match(script, /exec "\$B" /, 'executa o binário instalado por lockfile');
    assert.ok(script.includes('B=tools/playwright-mcp/node_modules/.bin/playwright-mcp'));
    assert.match(script, /\[ -x "\$B" \] \|\| \{ .*exit 2; \}/, 'binário ausente falha fechado (exit 2), sem cair em npx');
    for (const flag of ['--isolated', '--browser chrome', '--output-dir .prisma/ui-verify']) assert.ok(script.includes(flag), flag);
    assert.match(script, /^case "\$UIPORT" in ''\|\*\[!0-9\]\*\) .*exit 2/, 'valida a porta antes do exec');
    assert.match(script, /--allowed-origins "http:\/\/localhost:\$UIPORT;http:\/\/127\.0\.0\.1:\$UIPORT"/);
    assert.ok(!script.includes('${'), 'nenhuma expansão do Claude Code dentro do texto do script (evita injeção)');
    assert.strictEqual(pw.env.UIPORT, '${PRISMA_UI_PORT:-3399}');
    assert.match(pw.env.PLAYWRIGHT_MCP_HEADLESS, /:-true\}$/);
});
test('.mcp.json: sem o binário instalado o script falha fechado (exit 2), sem npx nem rede (execução real)', () => {
    const { spawnSync } = require('node:child_process');
    const pw = JSON.parse(fs.readFileSync(path.join(repo, '.mcp.json'), 'utf8')).mcpServers.playwright;
    const empty = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'pw-sem-binario-'));
    try {
        const r = spawnSync('sh', ['-c', pw.args[pw.args.indexOf('-c') + 1]], { cwd: empty, env: { PATH: process.env.PATH, UIPORT: '3399' }, encoding: 'utf8' });
        assert.strictEqual(r.status, 2);
        assert.match(r.stderr, /npm ci --ignore-scripts/);
    } finally { fs.rmSync(empty, { recursive: true, force: true }); }
});
test('.mcp.json: a validação da porta rejeita valor malicioso (execução real do script)', () => {
    const { spawnSync } = require('node:child_process');
    const pw = JSON.parse(fs.readFileSync(path.join(repo, '.mcp.json'), 'utf8')).mcpServers.playwright;
    const script = pw.args[pw.args.indexOf('-c') + 1].replace(/B=tools[\s\S]*$/, 'echo OK');
    for (const bad of ['1;http://evil.example', '*', '', '33 99', '$(id)']) {
        assert.strictEqual(spawnSync('sh', ['-c', script], { env: { PATH: process.env.PATH, UIPORT: bad } }).status, 2, JSON.stringify(bad));
    }
    assert.strictEqual(spawnSync('sh', ['-c', script], { env: { PATH: process.env.PATH, UIPORT: '3399' }, encoding: 'utf8' }).stdout.trim(), 'OK');
});
test('settings.json versionado: sem pré-aprovar o MCP nem liberar ferramentas; deny versionado; guarda de filename ligada', () => {
    const s = JSON.parse(fs.readFileSync(path.join(repo, '.claude/settings.json'), 'utf8'));
    assert.strictEqual(s.enabledMcpjsonServers, undefined, 'aprovação do servidor não vai para o git');
    assert.ok(!(s.permissions?.allow || []).some(p => p.startsWith('mcp__playwright__')), 'allow do navegador não vai para o git');
    const deny = s.permissions?.deny || [];
    for (const t of ['browser_evaluate', 'browser_run_code_unsafe', 'browser_file_upload', 'browser_drop']) {
        assert.ok(deny.includes(`mcp__playwright__${t}`), `deny ${t}`);
    }
    const guard = (s.hooks.PreToolUse || []).find(h => /playwright/.test(h.matcher));
    assert.ok(guard && /playwright-fs-guard/.test(JSON.stringify(guard)));
});
test('exemplo de settings.local: allow explícito, sem curinga, sem evaluate, sem execução arbitrária ou upload', () => {
    const ex = JSON.parse(fs.readFileSync(path.join(repo, '.claude/settings.local.json.example'), 'utf8'));
    assert.deepStrictEqual(ex.enabledMcpjsonServers, ['playwright']);
    const allow = ex.permissions.allow;
    assert.ok(allow.length > 0 && allow.every(p => p.startsWith('mcp__playwright__browser_')));
    assert.ok(!allow.some(p => /\*|evaluate|run_code|file_upload|route|cookie|storage|drop/.test(p)));
});
