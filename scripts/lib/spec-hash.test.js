// node --test scripts/lib/spec-hash.test.js
// HASH_SCOPE (.claude/spec-hash-config.json): o que entra e o que não entra no spec_hash
// contratual, forma canônica estável, escopos versionados e o diff_summary legível.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const sh = require('./spec-hash');

const SPEC = `---
spec_template_version: 1
ticket: 43700
---
# Ticket #43700 — Desconto por volume

## Contexto
Hoje o relatório não mostra o desconto.

## Objetivo
Transportadora vê o desconto aplicado.

## Escopo
**Inclui:**
- relatório de fretes

## Critérios de Aceite
- AC-01: Fretes com mais de 10 volumes recebem 5% de desconto.
- AC-02: O relatório exibe o desconto aplicado por frete.

## Restrições
- Não alterar o contrato do endpoint de cotação.

## Referências
- ticket #43600
`;

test('config: escopo atual existe e é o que a CLI usa por padrão', () => {
    const config = sh.loadConfig();
    assert.strictEqual(config.current, 'contract_sections_v1');
    assert.ok(config.scopes[config.current].include.some(s => s.id === 'acceptance_criteria'));
    assert.strictEqual(sh.contractHash(SPEC), sh.contractHash(SPEC, { scope: 'contract_sections_v1' }));
    assert.match(sh.contractHash(SPEC), /^[0-9a-f]{64}$/);
});

test('forma canônica: só seções contratuais, na ordem do config, sem cabeçalho/frontmatter/comentário', () => {
    const canon = sh.canonicalContract(SPEC);
    assert.ok(canon.startsWith('scope:contract_sections_v1\n[acceptance_criteria]\n- AC-01: Fretes'));
    assert.ok(canon.includes('[objective]\nTransportadora vê o desconto aplicado.'));
    assert.ok(canon.includes('[constraints]\n- Não alterar o contrato'));
    for (const out of ['Hoje o relatório', 'ticket #43600', 'spec_template_version', '## Critérios']) assert.ok(!canon.includes(out), out);
});

test('fora do HASH_SCOPE: comentário, espaço, frontmatter, Contexto, Referências, Histórico e Casos-limite não mudam o hash', () => {
    const base = sh.contractHash(SPEC);
    const variants = [
        SPEC.replace('- AC-01: Fretes', '<!-- revisar -->\n- AC-01:   Fretes  '),
        SPEC.replace(/\n/g, '\r\n'),
        SPEC.replace('ticket: 43700', 'ticket: 43700\nautor: fulano\ndata: 2026-10-01'),
        SPEC.replace('Hoje o relatório não mostra o desconto.', 'Contexto reescrito do zero.'),
        SPEC.replace('- ticket #43600', '- ticket #43600\n- print.png'),
        SPEC.replace('## Critérios de Aceite', '## Critérios de aceite'),
        SPEC + '\n## Histórico de Mudanças\n\n### SC-001 · aprovado\n- Antes: x\n',
        SPEC + '\n## Decisões de Implementação\n\n### implement · 2026 · 43700\n- Impacto no spec: nenhum\n',
        SPEC.replace('## Restrições', '### Casos-limite / Pontos a esclarecer\n- e se o volume for 0?\n\n## Restrições'),
        SPEC.replace('## Escopo', '## Pontos a esclarecer\n- dúvida aberta\n\n## Escopo'),
    ];
    variants.forEach((v, i) => assert.strictEqual(sh.contractHash(v), base, `variante ${i}`));
});

test('reordenar seções contratuais não muda o hash (ordem é a do config)', () => {
    const reordered = SPEC.replace(/## Objetivo\n[^#]*/, '').replace('## Referências', '## Objetivo\nTransportadora vê o desconto aplicado.\n\n## Referências');
    assert.strictEqual(sh.contractHash(reordered), sh.contractHash(SPEC));
});

test('dentro do HASH_SCOPE: AC, Objetivo, Escopo e Restrições mudam o hash', () => {
    const base = sh.contractHash(SPEC);
    for (const v of [
        SPEC.replace('5% de desconto', '7% de desconto'),
        SPEC.replace('- AC-02: O relatório', '- AC-02: (removido em 2026-10-01: SC-001) O relatório'),
        SPEC.replace('Transportadora vê', 'Cliente vê'),
        SPEC.replace('- relatório de fretes', '- relatório de fretes\n- exportação'),
        SPEC.replace('Não alterar o contrato', 'Pode alterar o contrato'),
        SPEC.replace('## Referências', '## Regras de Negócio\n- desconto não acumula\n\n## Referências'),
    ]) assert.notStrictEqual(sh.contractHash(v), base);
});

test('escopo: id desconhecido lança (escopo usado por run nunca some); escopos diferentes não colidem', () => {
    assert.throws(() => sh.contractHash(SPEC, { scope: 'nao_existe' }), /HASH_SCOPE "nao_existe"/);
    const dir = fs.mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'spec-hash-'));
    const file = path.join(dir, 'cfg.json');
    const raw = JSON.parse(fs.readFileSync(sh.CONFIG_PATH, 'utf8'));
    raw.scopes.acs_only_v1 = { include_sections: [{ id: 'acceptance_criteria', headings: ['^criterios? de aceit'] }], exclude_sections: [] };
    fs.writeFileSync(file, JSON.stringify(raw));
    const config = sh.loadConfig(file);
    const acsOnly = sh.contractHash(SPEC, { scope: 'acs_only_v1', config });
    assert.notStrictEqual(acsOnly, sh.contractHash(SPEC, { config }));
    assert.strictEqual(sh.contractHash(SPEC.replace('Não alterar', 'Pode alterar'), { scope: 'acs_only_v1', config }), acsOnly);
});

test('fingerprint + diffSummary: AC adicionado, removido, reformulado e seção alterada em texto legível', () => {
    const before = sh.fingerprint(SPEC);
    assert.deepStrictEqual(Object.keys(before.acs), ['AC-01', 'AC-02']);
    const after = sh.fingerprint(SPEC
        .replace('- AC-02: O relatório exibe', '- AC-02: (removido em 2026-10-01: SC-001) O relatório exibe')
        .replace('5% de desconto', '7% de desconto')
        .replace('Não alterar o contrato', 'Pode alterar o contrato')
        .replace('## Restrições', '- AC-03: Exportação CSV inclui a coluna.\n\n## Restrições'));
    assert.strictEqual(sh.diffSummary(before, after), 'AC-01 reformulado; AC-02 removido; AC-03 adicionado; Restrições alterada');
    assert.strictEqual(sh.diffSummary(before, before), 'sem mudança no HASH_SCOPE');
    assert.strictEqual(sh.diffSummary(null, after), null);
});

test('CLI: hash, --canonical e escopo inválido', () => {
    const dir = fs.mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'spec-hash-cli-'));
    const file = path.join(dir, 's.md');
    fs.writeFileSync(file, SPEC);
    const cli = args => spawnSync(process.execPath, [path.join(__dirname, 'spec-hash.js'), ...args], { encoding: 'utf8' });
    assert.strictEqual(cli([file]).stdout.trim(), sh.contractHash(SPEC));
    assert.ok(cli([file, '--canonical']).stdout.startsWith('scope:contract_sections_v1'));
    assert.strictEqual(cli([file, '--scope=xx']).status, 2);
    assert.strictEqual(cli([path.join(dir, 'nao.md')]).status, 2);
});
