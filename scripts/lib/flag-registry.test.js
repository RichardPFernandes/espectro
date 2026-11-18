// node --test lib/flag-registry.test.js
// PRI-377 (F1.1): registro de flags (docs/flags.md) conferido contra o código.
// Parte pura (fixtures em string) e parte contra o repositório real.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateAll, ENV_READ_RES } = require('./config-validator');
const { parseFlagRegistry, checkFlagRegistry, flagShapedReads, inspectRepo, unreadExampleVars, readsOf, COLUMNS, summarizeFlags, summarizeFlagRegistry } = require('./flag-registry');

const REAL_ROOT = path.resolve(__dirname, '..', '..');
const HEADER = `| ${COLUMNS.join(' | ')} |\n|${COLUMNS.map(() => ' -- ').join('|')}|\n`;

function row(over = {}) {
    const base = {
        Flag: '`MINHA_FLAG`', Onde: 'env', 'Padrão': 'desligada', Issue: 'PRI-1', Consumidor: 'não verificado',
        'Ligar quando': 'piloto fecha', 'Desligar ou remover quando': 'piloto reprova', 'Decidir até': '2026-12-07',
        'Item desligado': 'sim',
    };
    const r = { ...base, ...over };
    return `| ${COLUMNS.map(c => r[c]).join(' | ')} |\n`;
}
const doc = (...rows) => `# Registro de flags\n\ntexto\n\n${HEADER}${rows.join('')}\nrodapé\n`;
const ok = { reads: new Set(['MINHA_FLAG']), flagReads: new Set(['MINHA_FLAG']), sourceExists: () => true, today: '2026-11-17' };
const codes = r => r.problems.map(p => p.code).sort();

test('parseFlagRegistry lê as linhas da tabela, sem crases, e para no fim dela', () => {
    const { rows, errors } = parseFlagRegistry(doc(row(), row({ Flag: '`OUTRA`' })));
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(rows.map(r => r.flag), ['MINHA_FLAG', 'OUTRA']);
    assert.strictEqual(rows[0].decidirAte, '2026-12-07');
    assert.strictEqual(rows[0].desligado, 'sim');
});

test('parseFlagRegistry: sem tabela ou com cabeçalho trocado é erro, nunca lista vazia', () => {
    assert.match(parseFlagRegistry('# nada aqui').errors[0], /tabela/i);
    const trocada = doc(row()).replace('Decidir até', 'Prazo');
    assert.match(parseFlagRegistry(trocada).errors[0], /cabeçalho/i);
});

test('registro válido: nenhum problema e contagem de itens construídos e desligados', () => {
    const r = checkFlagRegistry({ markdown: doc(row(), row({ Flag: '`B`', 'Item desligado': 'não', 'Padrão': 'ligada' })), ...ok, reads: new Set(['MINHA_FLAG', 'B']), flagReads: new Set(['MINHA_FLAG']) });
    assert.deepStrictEqual(r.problems, []);
    assert.deepStrictEqual({ flags: r.flags, desligados: r.desligados }, { flags: 2, desligados: 1 });
});

test('AC-02: flag sem data, com data inválida ou vencida falha; data de hoje ainda vale', () => {
    const run = d => codes(checkFlagRegistry({ markdown: doc(row({ 'Decidir até': d })), ...ok }));
    assert.deepStrictEqual(run(''), ['DATE_MISSING']);
    assert.deepStrictEqual(run('—'), ['DATE_INVALID']);
    assert.deepStrictEqual(run('2026-02-30'), ['DATE_INVALID']);
    assert.deepStrictEqual(run('17/11/2026'), ['DATE_INVALID']);
    assert.deepStrictEqual(run('2026-11-16'), ['DATE_EXPIRED']);
    assert.deepStrictEqual(run('2026-11-17'), []);
});

test('AC-01: leitura com forma de flag que não está na tabela falha, com o nome da variável', () => {
    const r = checkFlagRegistry({ markdown: doc(row()), ...ok, flagReads: new Set(['MINHA_FLAG', 'NOVA_FLAG']) });
    assert.deepStrictEqual(r.problems.map(p => [p.code, p.flag]), [['READ_NOT_REGISTERED', 'NOVA_FLAG']]);
});

test('flag de env que o código não lê mais (linha morta) falha; fonte fora de env checa a existência', () => {
    const morta = checkFlagRegistry({ markdown: doc(row()), ...ok, reads: new Set() });
    assert.deepStrictEqual(codes(morta), ['FLAG_NOT_READ']);
    const arq = row({ Flag: 'roteamento', Onde: '`.claude/model-routing.json#mode`', 'Item desligado': 'não', 'Padrão': 'ligada' });
    const sem = checkFlagRegistry({ markdown: doc(row(), arq), ...ok, sourceExists: onde => onde === 'env' });
    assert.deepStrictEqual(sem.problems.map(p => [p.code, p.flag]), [['SOURCE_MISSING', 'roteamento']]);
});

test('linha incompleta, valor fora do vocabulário, duplicada e desligado=sim com padrão ligada falham', () => {
    const run = (...rows) => codes(checkFlagRegistry({ markdown: doc(...rows), ...ok }));
    assert.deepStrictEqual(run(row({ 'Ligar quando': '' })), ['ROW_INCOMPLETE']);
    assert.deepStrictEqual(run(row({ 'Padrão': 'talvez' })), ['VALUE_INVALID']);
    assert.deepStrictEqual(run(row({ 'Item desligado': 'quase' })), ['VALUE_INVALID']);
    assert.deepStrictEqual(run(row({ Issue: 'um dia' })), ['VALUE_INVALID']);
    assert.deepStrictEqual(run(row(), row()), ['DUPLICATE']);
    assert.deepStrictEqual(run(row({ 'Padrão': 'ligada' })), ['VALUE_INVALID']);
});

test('flagShapedReads reconhece as formas de booleano do código e ignora valor comum', () => {
    const lines = [
        "const a = /^(1|true|sim)$/i.test(process.env.FLAG_A || '');",
        "const b = process.env.FLAG_B !== '0';",
        "const c = env.FLAG_C === 'on';",
        "const d = !/^(0|false|nao|não|no)$/i.test(process.env.FLAG_D || '');",
        "const e = (env.FLAG_E || 'off').toLowerCase();",
        "const porta = Number(process.env.PORTA_X) || 3000;",
        "// const f = process.env.FLAG_F === '1'",
    ];
    assert.deepStrictEqual([...flagShapedReads(lines)].sort(), ['FLAG_A', 'FLAG_B', 'FLAG_C', 'FLAG_D', 'FLAG_E']);
});

test('flagShapedReads: leitura atribuída a alias vale quando o alias é comparado depois como booleano', () => {
    const obsidian = [
        'function create({ env = {} }) {',
        '    const flag = env.FLAG_ALIAS;',
        "    if (flag !== undefined && !['on', 'off'].includes(flag)) warn();",
        "    const enabled = flag === 'on';",
        '}',
    ];
    assert.deepStrictEqual([...flagShapedReads(obsidian)], ['FLAG_ALIAS']);
    const semComparacao = ['const token = env.SEGREDO_X;', 'fetch(url, { headers: { token } });', "const modo = outra === 'on';"];
    assert.deepStrictEqual([...flagShapedReads(semComparacao)], []);
    assert.deepStrictEqual([...flagShapedReads(["if (!['on', 'off'].includes(env.FLAG_INCL)) fail();"])], ['FLAG_INCL']);
});

test('inspectRepo liga scanner, detecção e tabela: flag lida e fora de docs/flags.md falha; com a linha, passa', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flag-registry-'));
    try {
        fs.mkdirSync(path.join(root, '.claude'));
        fs.mkdirSync(path.join(root, 'scripts'));
        fs.mkdirSync(path.join(root, 'docs'));
        fs.writeFileSync(path.join(root, '.claude', 'config-contract.json'), JSON.stringify({
            contractVersion: '1.0.0', env: { scan: { dirs: ['scripts'], extensions: ['.js'] }, ignore: {} },
        }));
        fs.writeFileSync(path.join(root, 'scripts', 'x.js'), "const ligado = process.env.FLAG_TEMP === 'on';\n");
        fs.writeFileSync(path.join(root, 'docs', 'flags.md'), doc());
        const sem = inspectRepo(root, { today: '2026-11-17' });
        assert.deepStrictEqual(sem.problems.map(p => [p.code, p.flag]), [['READ_NOT_REGISTERED', 'FLAG_TEMP']]);
        fs.writeFileSync(path.join(root, 'docs', 'flags.md'), doc(row({ Flag: '`FLAG_TEMP`' })));
        assert.deepStrictEqual(inspectRepo(root, { today: '2026-11-17' }).problems, []);
        assert.deepStrictEqual(codes(inspectRepo(root, { today: '2026-12-08' })), ['DATE_EXPIRED']);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('scanner de ambiente enxerga leitura por objeto *Env (consumerEnv), não só env e process.env', () => {
    const lidas = linha => [...linha.matchAll(ENV_READ_RES[0])].map(m => m[1]);
    assert.deepStrictEqual(lidas("const id = (consumerEnv.BITBUCKET_ACCOUNT_ID || '').trim();"), ['BITBUCKET_ACCOUNT_ID']);
    assert.deepStrictEqual(lidas('if (process.env.A_FLAG && env.B_FLAG) {}'), ['A_FLAG', 'B_FLAG']);
    assert.deepStrictEqual(lidas('const porta = config.PORTA_X;'), []);
});

test('unreadExampleVars: variável do exemplo fora das leituras exige "Leitura fora do scanner:" no comentário dela', () => {
    const exemplo = [
        '# lida normalmente', 'LIDA=', '',
        '# Leitura fora do scanner: preview-manager.js, configuredRepo().', 'INDIRETA=', '',
        '# Leitura fora do scanner:', 'VAZIA=', '',
        '# comentário sem a justificativa', 'SOBRA=', '',
        '# DRY_RUN_X=', '',
    ].join('\n');
    const r = unreadExampleVars(exemplo, new Set(['LIDA']));
    assert.deepStrictEqual(r.map(x => [x.name, x.justification]), [
        ['INDIRETA', 'preview-manager.js, configuredRepo().'], ['VAZIA', null], ['SOBRA', null], ['DRY_RUN_X', null],
    ]);
});

test('AC-03: toda variável lida pelo código está no .env.example ou ignorada com motivo no contrato', () => {
    const contract = path.join(REAL_ROOT, '.claude', 'config-contract.json');
    const report = validateAll(contract, { root: REAL_ROOT, rules: ['env-documented'] });
    const falhas = report.results.filter(r => !r.passed && r.severity !== 'info');
    assert.deepStrictEqual(falhas.map(r => `${r.message}: ${(r.details || []).join(', ')}`), []);
});

test('AC-03: variável do .env.example sem leitura no código tem justificativa (sai ou explica)', () => {
    const sem = unreadExampleVars(fs.readFileSync(path.join(REAL_ROOT, '.env.example'), 'utf8'), readsOf(REAL_ROOT)).filter(x => !x.justification);
    assert.deepStrictEqual(sem.map(x => x.name), [], 'adicione "# Leitura fora do scanner: <onde>" ao comentário, ou remova a variável');
});

test('repositório real (AC-01, AC-02, AC-04): docs/flags.md confere com o código e nenhuma data venceu', () => {
    const r = inspectRepo(REAL_ROOT);
    assert.deepStrictEqual(r.problems, [], r.problems.map(p => `${p.code} ${p.flag}: ${p.message}`).join('\n'));
    assert.ok(r.flags > 0);
});

// PRI-399 (F0.9, AC-03, métrica 4): resumo do registro para o relatório semanal.
test('summarizeFlags conta padrão, consumidor, vencidas (antes de hoje, UTC) e itens desligados', () => {
    const { rows } = parseFlagRegistry(doc(
        row({ Flag: '`FLAG_90003_A`', 'Decidir até': '2026-11-16' }),
        row({ Flag: '`FLAG_90003_B`', 'Decidir até': '2026-11-17', Consumidor: 'não verificado (marcador 90003-x)' }),
        row({ Flag: '`FLAG_90003_C`', 'Padrão': 'ligada', 'Item desligado': 'não', Consumidor: 'marcador 90003-y', 'Decidir até': '2027-01-01' }),
    ));
    assert.deepStrictEqual(summarizeFlags(rows, '2026-11-17'), {
        n: 3,
        padrao: { ligada: 1, desligada: 2 },
        consumidor: { nao_verificado: 2, outro: 1 },
        vencidas: 1,
        itens_desligados: 2,
        fonte: 'docs/flags.md',
        hoje: '2026-11-17',
    });
});

test('summarizeFlagRegistry: tabela válida dá ok com o resumo', () => {
    const r = summarizeFlagRegistry(doc(row({ Flag: '`FLAG_90003_A`' })), '2026-11-17');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.summary.n, 1);
    assert.strictEqual(r.summary.itens_desligados, 1);
});

test('summarizeFlagRegistry: tabela quebrada, ausente ou vazia é ok:false, nunca zero', () => {
    const quebrada = doc(row(), '| `FLAG_90003_X` | env | desligada |\n');
    for (const md of [quebrada, '# nada aqui', doc(row()).replace('Decidir até', 'Prazo'), doc()]) {
        const r = summarizeFlagRegistry(md, '2026-11-17');
        assert.strictEqual(r.ok, false, md);
        assert.strictEqual(r.summary, undefined);
        assert.match(r.error, /\S/);
    }
});
