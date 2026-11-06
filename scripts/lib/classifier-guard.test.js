// node --test scripts/lib/classifier-guard.test.js
// PRI-205 S3b T2: verificador de conteúdo do envelope do Jev (SPEC §B5, R-7
// fail-closed). Bloqueia sem redigir e nunca devolve o trecho encontrado.
// Todos os valores são sintéticos e montados em tempo de execução: nenhum é
// credencial ou documento real.
const test = require('node:test');
const assert = require('node:assert');
const guard = require('./classifier-guard');

// Dígitos verificadores de CPF/CNPJ calculados aqui, para não fixar número real.
function cpfWithDv(base9) {
    const d = base9.split('').map(Number);
    const dv = (arr, start) => {
        const s = arr.reduce((acc, n, i) => acc + n * (start - i), 0);
        const r = (s * 10) % 11;
        return r === 10 ? 0 : r;
    };
    d.push(dv(d, 10));
    d.push(dv(d, 11));
    return d.join('');
}
function cnpjWithDv(base12) {
    const d = base12.split('').map(Number);
    const dv = arr => {
        const w = arr.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
        const r = arr.reduce((acc, n, i) => acc + n * w[i], 0) % 11;
        return r < 2 ? 0 : 11 - r;
    };
    d.push(dv(d));
    d.push(dv(d));
    return d.join('');
}

const CPF = cpfWithDv('123456789');
const CPF_FMT = `${CPF.slice(0, 3)}.${CPF.slice(3, 6)}.${CPF.slice(6, 9)}-${CPF.slice(9)}`;
const CNPJ = cnpjWithDv('112223330001');
const CNPJ_FMT = `${CNPJ.slice(0, 2)}.${CNPJ.slice(2, 5)}.${CNPJ.slice(5, 8)}/${CNPJ.slice(8, 12)}-${CNPJ.slice(12)}`;
const GH = 'ghp' + '_' + 'a1B2c3D4'.repeat(5);
const AWS = 'AK' + 'IA' + 'QWERTYUIOPASDFGH';
const JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjMifQ', 'c2lnbmF0dXJhLWZha2UtZGUtdGVzdGU'].join('.');
const PEM = '-----BEGIN ' + 'RSA PRIVATE KEY-----';
const ENTROPY = 'Zx8' + 'Qp2Lm7Rt9Vb4Nc6Kd1Hs3Jw5Gf0Ty8Ue';

function env(stepText, extra = {}) {
    return { step_text: stepText, ac_texts: [], declared_paths: [], ...extra };
}

const POSITIVE = [
    ['token com prefixo conhecido', `usar ${GH} no teste`, 'secret_token'],
    ['chave de acesso estilo AWS', `chave ${AWS}`, 'secret_token'],
    ['Bearer', 'enviar Authorization: Bearer abcdefghijklmnop1234', 'secret_token'],
    ['JWT', `token ${JWT}`, 'secret_token'],
    ['bloco PEM', `colar ${PEM}`, 'secret_token'],
    ['string de alta entropia', `valor ${ENTROPY}`, 'secret_token'],
    ['credencial em URL', 'acessar https://usuario:segredo@host.interno/api', 'url_credentials'],
    ['connection string', 'conectar em postgresql://db.interno:5432/app', 'connection_string'],
    ['JDBC', 'jdbc:oracle:thin:@db.interno:1521/APP', 'connection_string'],
    ['atribuição de senha', 'definir password=Troca123 no arquivo', 'credential_assignment'],
    ['e-mail', 'avisar fulano.de.tal@empresa.com.br', 'email'],
    ['CPF formatado', `cliente ${CPF_FMT}`, 'cpf'],
    ['CPF só dígitos', `cliente ${CPF}`, 'cpf'],
    ['CNPJ formatado', `empresa ${CNPJ_FMT}`, 'cnpj'],
    ['telefone com DDD', 'ligar para (11) 98765-4321', 'phone_br'],
    ['telefone +55', 'ligar para +55 11 98765 4321', 'phone_br'],
    ['IPv4 não loopback', 'servidor 10.20.30.40', 'ip_address'],
    ['IPv6 não loopback', 'servidor fe80::1ff:fe23:4567:890a', 'ip_address'],
    ['cartão com Luhn', 'cartão 4111 1111 1111 1111', 'payment_card'],
    ['IBAN', 'conta GB82WEST12345698765432', 'iban'],
];

for (const [name, text, category] of POSITIVE) {
    test(`bloqueia: ${name} → ${category}`, () => {
        const r = guard.checkEnvelope(env(text));
        assert.strictEqual(r.ok, false);
        assert.ok(r.categories.includes(category), `categorias: ${r.categories.join(',')}`);
    });
}

const NEGATIVE = [
    ['passo comum com caminhos e AC', 'Alterar backend/svc-a/src/main/java/X.java para cobrir AC-01 e AC-02'],
    ['versão, hora e data', 'Atualizar para v1.2.3 às 10:30:00 em 2026-11-06'],
    ['número de ticket e contagens', 'Ticket #43608: 6 arquivos, 3 ACs'],
    ['URL sem credencial', 'Ver https://example.com/docs/guia'],
    ['loopback', 'Subir em 127.0.0.1:3333 e ::1'],
    ['CPF com dígito errado', `documento ${CPF.slice(0, 9)}${(Number(CPF[9]) + 1) % 10}${CPF[10]}`],
    ['sequência que falha no Luhn', 'pedido 4111 1111 1111 1112'],
    ['palavra password sem valor', 'O campo password é obrigatório no formulário'],
];

for (const [name, text] of NEGATIVE) {
    test(`deixa passar: ${name}`, () => {
        assert.deepStrictEqual(guard.checkEnvelope(env(text)), { ok: true });
    });
}

test('ACs e caminhos declarados também são verificados', () => {
    const viaAc = guard.checkEnvelope(env('passo limpo', { ac_texts: ['AC-01 enviar para fulano@empresa.com'] }));
    assert.deepStrictEqual([viaAc.ok, viaAc.categories, viaAc.fields], [false, ['email'], ['ac_texts']]);
    const viaPath = guard.checkEnvelope(env('passo limpo', { declared_paths: [`config/${GH}.json`] }));
    assert.deepStrictEqual([viaPath.ok, viaPath.fields], [false, ['declared_paths']]);
});

test('o resultado nunca contém o trecho encontrado', () => {
    const r = guard.checkEnvelope(env(`a ${GH} b ${CPF_FMT} c fulano@empresa.com`));
    const out = JSON.stringify(r);
    for (const secret of [GH, CPF_FMT, CPF, 'fulano@empresa.com']) assert.ok(!out.includes(secret));
    assert.deepStrictEqual(r.categories, ['cpf', 'email', 'secret_token']);
});

test('não altera o envelope', () => {
    const e = env(`texto ${GH}`, { ac_texts: ['AC-01'], declared_paths: ['a.js'] });
    const before = JSON.stringify(e);
    guard.checkEnvelope(e);
    assert.strictEqual(JSON.stringify(e), before);
});

test('fail-closed: campo inesperado, tipo errado ou envelope ausente bloqueiam', () => {
    assert.deepStrictEqual(guard.checkEnvelope(env('ok', { codigo: 'x' })).categories, ['unexpected_field']);
    assert.deepStrictEqual(guard.checkEnvelope(env(42)).categories, ['malformed']);
    assert.deepStrictEqual(guard.checkEnvelope({ step_text: 'ok', ac_texts: 'x', declared_paths: [] }).categories, ['malformed']);
    assert.deepStrictEqual(guard.checkEnvelope(null).categories, ['malformed']);
});

test('GUARD_VERSION existe para entrar no classifier_ref e na admissão', () => {
    assert.match(guard.GUARD_VERSION, /^classifier-guard@\d+$/);
});
