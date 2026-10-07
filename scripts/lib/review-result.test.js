// node --test scripts/lib/review-result.test.js
// Review em duas dimensões (Spec Compliance + Engineering Review): regras de
// classificação de divergência, veredito geral, failure_origin, handoff estruturado —
// unidade (evaluate) + CLI num repo sintético + integração com o Verify
// (spec-authority) e com o schema do state.json.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const rr = require('./review-result');
const sa = require('./spec-authority');
const { validateState } = require('../validate-state');

const CLI = path.join(__dirname, 'review-result.js');
const SPEC_PATH = 'memory/spec/43700-spec.md';
const TASK_ID = '43700-filtro';
const SPEC = `# Spec 43700

## Problema
Filtro de transportadora lista todas as transportadoras cadastradas.

## Critérios de Aceite
- AC-01: Filtro de transportadora lista somente transportadoras presentes no resultado da tela.
- AC-02: Novo filtro de operação de transporte com o mesmo comportamento dinâmico.
- AC-03: Exportação antiga (removido em 2026-09-29: fora do escopo)

## Restrições
- Não alterar o contrato do endpoint de Zona de Transporte.
`;

const ACTIVE = ['AC-01', 'AC-02'];
const CTX = { activeAcs: ACTIVE, knownAcs: ['AC-01', 'AC-02', 'AC-03'], specApplies: true, decisions: [] };

function engItems(overrides = {}) {
    return rr.CHECKLIST.map(c => ({ n: c.n, result: overrides[c.n] || (c.n === 5 || c.n === 8 ? 'N/A' : 'PASS'), note: `item ${c.n} conferido` }));
}

function checks(overrides = {}) {
    return Object.fromEntries(rr.SPEC_CHECKS.map(c => [c.key, { result: overrides[c.key] || 'PASS', note: `${c.key} conferido` }]));
}

function passingInput() {
    return {
        spec_compliance: {
            acs: [
                { id: 'AC-01', result: 'PASS', evidence: 'src/TorreResource.java:42 filtra pelo resultado' },
                { id: 'AC-02', result: 'PASS', evidence: 'src/TorreResource.java:58 filtro de operação' },
            ],
            checks: checks(),
        },
        divergences: [],
        engineering: { items: engItems(), findings: [] },
        observations: [],
    };
}

const BUG = {
    classification: 'IMPLEMENTATION_BUG', ac: 'AC-02', file: 'src/TorreResource.java', line: 58,
    summary: 'filtro de operação lista todas as operações',
    expected: 'Filtro de operação lista só operações presentes no resultado da tela (AC-02)',
    found: 'listarOperacoes() consulta a tabela inteira, sem o filtro do resultado',
    action: 'Em TorreResource.listarOperacoes, restringir a consulta aos ids de operação do resultado paginado atual',
};

const ENG_FINDING = {
    item: 6, file: 'src/TorreService.java', line: 77,
    expected: 'Log de erro sem payload do request', found: 'LOG.error imprime o body inteiro com CPF',
    action: 'Trocar LOG.error(body) por LOG.error com só o id da viagem e a mensagem da exceção',
};

// ── evaluate ─────────────────────────────────────────────────────────────────────

test('duas dimensões PASS → resultado geral PASS e failure_origin null', () => {
    const { errors, result } = rr.evaluate(passingInput(), CTX);
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(result.verdict, 'PASS');
    assert.strictEqual(result.failure_origin, null);
    assert.strictEqual(result.spec_compliance.verdict, 'PASS');
    assert.strictEqual(result.engineering.verdict, 'PASS');
    assert.strictEqual(result.spec_compliance.acs['AC-01'].evidence, 'src/TorreResource.java:42 filtra pelo resultado');
});

test('IMPLEMENTATION_BUG reprova só a Spec Compliance (failure_origin=spec_compliance)', () => {
    const input = passingInput();
    input.spec_compliance.acs[1] = { id: 'AC-02', result: 'FAIL', reason: 'lista todas as operações' };
    input.divergences = [BUG];
    const { errors, result } = rr.evaluate(input, CTX);
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(result.verdict, 'FAIL');
    assert.strictEqual(result.spec_compliance.verdict, 'FAIL');
    assert.strictEqual(result.engineering.verdict, 'PASS');
    assert.strictEqual(result.failure_origin, 'spec_compliance');
    assert.deepStrictEqual(result.findings[0], {
        category: 'IMPLEMENTATION_BUG', ac: 'AC-02', file: 'src/TorreResource.java', line: 58,
        expected: BUG.expected, found: BUG.found, action: BUG.action,
    });
});

test('item técnico reprovado → failure_origin=engineering; os dois → both', () => {
    const eng = passingInput();
    eng.engineering = { items: engItems({ 6: 'FAIL' }), findings: [ENG_FINDING] };
    let r = rr.evaluate(eng, CTX).result;
    assert.strictEqual(r.verdict, 'FAIL');
    assert.strictEqual(r.spec_compliance.verdict, 'PASS');
    assert.strictEqual(r.failure_origin, 'engineering');
    assert.strictEqual(r.findings[0].category, 'ENGINEERING');

    eng.spec_compliance.acs[1] = { id: 'AC-02', result: 'FAIL', reason: 'x' };
    eng.divergences = [BUG];
    r = rr.evaluate(eng, CTX).result;
    assert.strictEqual(r.failure_origin, 'both');
    assert.strictEqual(r.findings.length, 2);
});

test('DOCUMENTED_TECHNICAL_DECISION registrada não reprova; sem registro reprova como UNREGISTERED', () => {
    const input = passingInput();
    input.divergences = [{ classification: 'DOCUMENTED_TECHNICAL_DECISION', ac: 'AC-01', file: 'src/X.java', summary: 'filtro feito em memória em vez de SQL' }];
    const decisions = [{ ac: 'AC-01', rationale: 'mesmo resultado, evita join', approved_at: '2026-09-30T10:00:00Z', source: 'state.json' }];
    let r = rr.evaluate(input, { ...CTX, decisions }).result;
    assert.strictEqual(r.verdict, 'PASS');
    assert.strictEqual(r.technical_decisions_applied[0].ac, 'AC-01');

    // Sem registro: reclassificada e precisa de esperado/encontrado/ação.
    let out = rr.evaluate(input, CTX);
    assert.ok(out.errors.some(e => /expected vazio/.test(e)), out.errors.join('\n'));
    Object.assign(input.divergences[0], { expected: 'decisão registrada em technical_decisions', found: 'nenhum registro para AC-01', action: 'Registrar em state.technical_decisions[] a decisão de filtrar em memória, ou voltar ao filtro SQL' });
    out = rr.evaluate(input, CTX);
    assert.deepStrictEqual(out.errors, []);
    assert.strictEqual(out.result.divergences[0].classification, 'UNREGISTERED_TECHNICAL_DECISION');
    assert.strictEqual(out.result.failure_origin, 'spec_compliance');
});

test('decisão "técnica" ou esclarecimento que altera comportamento → SPEC_CHANGE_REQUIRED, reprova mesmo registrada', () => {
    const decisions = [{ ac: 'AC-01', rationale: 'r', approved_at: '2026-09-30T10:00:00Z', source: 'state.json' }];
    for (const classification of ['DOCUMENTED_TECHNICAL_DECISION', 'SPEC_CLARIFICATION']) {
        const input = passingInput();
        input.divergences = [{
            classification, ac: 'AC-01', file: 'src/X.java', alters_behavior: true, summary: 'filtro passa a incluir inativas',
            expected: 'Só transportadoras do resultado', found: 'inclui transportadoras inativas fora do resultado',
            action: 'Remover o OR ativo=false da consulta em TransportadoraDao.listarDoResultado',
        }];
        const r = rr.evaluate(input, { ...CTX, decisions }).result;
        assert.strictEqual(r.divergences[0].classification, 'SPEC_CHANGE_REQUIRED', classification);
        assert.strictEqual(r.divergences[0].declared_classification, classification);
        assert.match(r.divergences[0].reclassified_reason, /altera comportamento/);
        assert.strictEqual(r.verdict, 'FAIL');
    }
});

test('SPEC_CLARIFICATION não reprova e segue para o Verify; SPEC_CHANGE sempre reprova', () => {
    const input = passingInput();
    input.divergences = [{ classification: 'SPEC_CLARIFICATION', ac: 'AC-02', summary: 'spec não dizia a ordem; ordenado por nome' }];
    let r = rr.evaluate(input, CTX).result;
    assert.strictEqual(r.verdict, 'PASS');
    assert.deepStrictEqual(r.spec_clarifications, [{ ac: 'AC-02', summary: 'spec não dizia a ordem; ordenado por nome', file: null, line: null }]);

    input.divergences = [{ ...BUG, classification: 'SPEC_CHANGE', summary: 'filtro virou multi-seleção' }];
    r = rr.evaluate(input, CTX).result;
    assert.strictEqual(r.divergences[0].classification, 'SPEC_CHANGE_REQUIRED');
    assert.strictEqual(r.findings[0].category, 'SPEC_CHANGE_REQUIRED');
    assert.strictEqual(r.verdict, 'FAIL');
});

test('entrada inválida: AC faltando, AC removido, AC FAIL sem divergência, item faltando, FAIL sem achado, ação genérica', () => {
    const missing = passingInput();
    missing.spec_compliance.acs.pop();
    assert.ok(rr.evaluate(missing, CTX).errors.some(e => /faltam ACs ativos da spec: AC-02/.test(e)));

    const removed = passingInput();
    removed.spec_compliance.acs.push({ id: 'AC-03', result: 'PASS', evidence: 'x' });
    assert.ok(rr.evaluate(removed, CTX).errors.some(e => /AC-03 foi removido/.test(e)));

    const noDiv = passingInput();
    noDiv.spec_compliance.acs[0] = { id: 'AC-01', result: 'FAIL', reason: 'não filtra' };
    assert.ok(rr.evaluate(noDiv, CTX).errors.some(e => /AC-01: FAIL sem divergência/.test(e)));

    const noEvidence = passingInput();
    noEvidence.spec_compliance.acs[0].evidence = '';
    assert.ok(rr.evaluate(noEvidence, CTX).errors.some(e => /AC-01: PASS sem evidência/.test(e)));

    const noItem = passingInput();
    noItem.engineering.items = noItem.engineering.items.filter(i => i.n !== 7);
    assert.ok(rr.evaluate(noItem, CTX).errors.some(e => /falta o item 7/.test(e)));

    const noFinding = passingInput();
    noFinding.engineering.items = engItems({ 1: 'FAIL' });
    assert.ok(rr.evaluate(noFinding, CTX).errors.some(e => /items\[1\]: FAIL sem achado/.test(e)));

    const generic = passingInput();
    generic.spec_compliance.acs[1] = { id: 'AC-02', result: 'FAIL', reason: 'x' };
    generic.divergences = [{ ...BUG, action: 'Corrigir lógica' }];
    assert.ok(rr.evaluate(generic, CTX).errors.some(e => /action genérica/.test(e)));
});

test('task sem spec: Spec Compliance N/A não impede PASS (só o Engineering decide)', () => {
    const input = { spec_compliance: { acs: [] }, engineering: { items: engItems(), findings: [] } };
    const r = rr.evaluate(input, { activeAcs: [], specApplies: false, decisions: [] }).result;
    assert.strictEqual(r.spec_compliance.verdict, 'N/A');
    assert.strictEqual(r.verdict, 'PASS');
    assert.strictEqual(r.failure_origin, null);
});

test('registeredDecisions: state.json + spec gate; entrada sem approved_at ISO é ignorada', () => {
    const { valid, invalid } = rr.registeredDecisions(
        { technical_decisions: [{ ac: 'ac-1', rationale: 'r', approved_at: '2026-09-30T10:00:00Z' }, { ac: 'AC-02', rationale: 'r', approved_at: 'ontem' }] },
        { technical_decisions: [{ ac: 'AC-02', rationale: 'aprovado no gate', approved_at: '2026-09-29T09:00:00-03:00' }] },
    );
    assert.deepStrictEqual(valid.map(d => [d.ac, d.source]), [['AC-01', 'state.json'], ['AC-02', 'spec-gate']]);
    assert.strictEqual(invalid.length, 1);
    assert.match(invalid[0].reason, /approved_at/);
});

test('upsertHandoffBlock preserva o resto do handoff e substitui o bloco entre rodadas', () => {
    const handoff = '# Handoff\n\n## Referência da Spec\n- Spec: memory/spec/43700-spec.md\n- ACs: AC-01, AC-02\n';
    const once = rr.upsertHandoffBlock(handoff, `${rr.HANDOFF_START}\nA\n${rr.HANDOFF_END}`);
    const twice = rr.upsertHandoffBlock(once, `${rr.HANDOFF_START}\nB\n${rr.HANDOFF_END}`);
    assert.ok(twice.startsWith(handoff.trimEnd()));
    assert.ok(twice.includes('\nB\n') && !twice.includes('\nA\n'));
    assert.strictEqual(twice.split(rr.HANDOFF_START).length, 2);
});

// ── CLI num repo sintético ───────────────────────────────────────────────────────

function makeRepo(stateExtra = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-result-'));
    fs.mkdirSync(path.join(root, 'memory/spec'), { recursive: true });
    const runDir = path.join(root, 'memory/runs', TASK_ID);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(root, SPEC_PATH), SPEC);
    const state = {
        task_id: TASK_ID, node: 'review', history: ['plan', 'implement'], status: 'in_progress',
        started_at: '2026-09-30T09:00:00Z', redmine_ticket: { id: 43700 },
        ...sa.baselineFields(root, SPEC_PATH, 'plan', '2026-09-30T09:00:00Z'),
        ...stateExtra,
    };
    fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify(state, null, 2));
    fs.writeFileSync(path.join(runDir, 'handoff.md'), `# Handoff\n\n## Referência da Spec\n- Spec: ${SPEC_PATH}\n- ACs: AC-01, AC-02\n`);
    return { root, runDir };
}

function run(args) {
    return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

function writeInput(runDir, input) {
    const file = path.join(runDir, 'review-input.json');
    fs.writeFileSync(file, JSON.stringify(input));
    return file;
}

test('CLI spec --template: lê a spec conferida pelo spec_hash; drift → exit 3', () => {
    const { root, runDir } = makeRepo();
    const ok = run(['spec', runDir, '--template']);
    assert.strictEqual(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /AC-01: Filtro de transportadora/);
    assert.match(ok.stdout, /AC-03 \(REMOVIDO — não avaliar\)/);
    assert.match(ok.stdout, /## Restrições\n- Não alterar o contrato/);
    const skeleton = JSON.parse(ok.stdout.slice(ok.stdout.indexOf('{')));
    assert.deepStrictEqual(skeleton.spec_compliance.acs.map(a => a.id), ACTIVE);
    assert.strictEqual(skeleton.engineering.items.length, 8);

    fs.appendFileSync(path.join(root, SPEC_PATH), '- AC-04: critério novo sem aprovação.\n');
    const drift = run(['spec', runDir]);
    assert.strictEqual(drift.status, 3);
    assert.match(drift.stderr, /SPEC DRIFT/);
    const input = writeInput(runDir, passingInput());
    assert.strictEqual(run(['record', runDir, `--input=${input}`]).status, 3);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8')).review_results, undefined);
});

test('CLI record: FAIL grava review_results/failure_origin, review-result.md e achados no handoff; depois PASS acumula history', () => {
    const { runDir } = makeRepo({ retries: { review: 0 } });
    // Entrada inválida: nada gravado.
    const bad = passingInput();
    bad.spec_compliance.acs.pop();
    const badRun = run(['record', runDir, `--input=${writeInput(runDir, bad)}`]);
    assert.strictEqual(badRun.status, 2);
    assert.ok(!fs.existsSync(path.join(runDir, rr.RESULT_FILE)));

    const failing = passingInput();
    failing.spec_compliance.acs[1] = { id: 'AC-02', result: 'FAIL', reason: 'lista todas as operações' };
    failing.divergences = [BUG];
    const r1 = run(['record', runDir, `--input=${writeInput(runDir, failing)}`]);
    assert.strictEqual(r1.status, 1, r1.stderr);
    assert.match(r1.stdout, /Spec Compliance: FAIL\nEngineering Review: PASS\nResultado geral: FAIL \(failure_origin: spec_compliance\)/);

    let state = JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
    assert.strictEqual(state.review_results.failure_origin, 'spec_compliance');
    assert.strictEqual(state.review_results.spec_hash, state.spec_hash);
    assert.strictEqual(state.review_verdict, 'reprovado (spec_compliance)');
    assert.strictEqual(state.node, 'review', 'record não mexe na aresta');
    assert.deepStrictEqual(validateState(state), { valid: true });

    const md = fs.readFileSync(path.join(runDir, rr.RESULT_FILE), 'utf8');
    assert.match(md, /- AC-01 — PASS \| Evidência: src\/TorreResource\.java:42/);
    assert.match(md, /- AC-02 — FAIL \| Motivo: lista todas as operações/);
    assert.match(md, /\[N\/A\] 8\. Endpoint bate com o contrato OpenAPI/);

    let handoff = fs.readFileSync(path.join(runDir, 'handoff.md'), 'utf8');
    assert.match(handoff, /## Referência da Spec/);
    for (const label of ['Categoria: IMPLEMENTATION_BUG', 'AC afetado: AC-02', 'Arquivo e linha: src/TorreResource.java:58',
        'Comportamento esperado:', 'Comportamento encontrado:', 'Ação esperada: Em TorreResource.listarOperacoes']) {
        assert.ok(handoff.includes(label), label);
    }

    // Rodada 2: Implement corrigiu, retries.review=1; esclarecimento de spec vai junto.
    state.retries = { review: 1 };
    fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify(state, null, 2));
    const passing = passingInput();
    passing.divergences = [{ classification: 'SPEC_CLARIFICATION', ac: 'AC-02', summary: 'ordenado por nome (spec não definia ordem)' }];
    const r2 = run(['record', runDir, `--input=${writeInput(runDir, passing)}`]);
    assert.strictEqual(r2.status, 0, r2.stderr);
    state = JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
    assert.strictEqual(state.review_results.verdict, 'PASS');
    assert.strictEqual(state.review_results.failure_origin, null);
    assert.deepStrictEqual(state.review_results.history.map(h => [h.round, h.verdict, h.failure_origin]), [[1, 'FAIL', 'spec_compliance'], [2, 'PASS', null]]);
    assert.deepStrictEqual(validateState(state), { valid: true });
    handoff = fs.readFileSync(path.join(runDir, 'handoff.md'), 'utf8');
    assert.ok(!handoff.includes('IMPLEMENTATION_BUG'), 'bloco da rodada anterior substituído');
    assert.match(handoff, /Review — APROVADO[\s\S]*Esclarecimentos de spec \(para o Verify\)[\s\S]*ordenado por nome/);

    // Chega ao Verify como aviso, sem reprovar.
    const v = sa.verifyRun(runDir, state);
    const clar = v.warnings.find(w => w.code === 'REVIEW_SPEC_CLARIFICATION');
    assert.ok(clar && /ordenado por nome/.test(clar.message));
    assert.ok(!v.failures.some(f => /^REVIEW_/.test(f.code)));
    assert.match(sa.formatReport(v, { taskId: TASK_ID, specPath: SPEC_PATH }), /## Esclarecimentos de spec \(Review\)/);
});

test('CLI record: decisão técnica aprovada no spec gate é aceita', () => {
    const { root, runDir } = makeRepo();
    fs.writeFileSync(path.join(root, 'memory/runs/43700-spec-gate.json'), JSON.stringify({
        ticket_id: 43700, status: 'valid',
        technical_decisions: [{ ac: 'AC-01', rationale: 'filtro em memória, mesmo resultado', approved_at: '2026-09-30T08:00:00Z' }],
    }));
    const input = passingInput();
    input.divergences = [{ classification: 'DOCUMENTED_TECHNICAL_DECISION', ac: 'AC-01', file: 'src/X.java', summary: 'filtro em memória' }];
    const r = run(['record', runDir, `--input=${writeInput(runDir, input)}`]);
    assert.strictEqual(r.status, 0, r.stderr);
    const state = JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
    assert.strictEqual(state.review_results.technical_decisions_applied[0].source, 'spec-gate');
});

test('schema: review_results com verdict/failure_origin fora do enum e technical_decisions sem approved_at são inválidos', () => {
    const base = { task_id: 't', node: 'review', history: [], status: 'in_progress' };
    const bad = validateState({ ...base, review_results: { verdict: 'OK', failure_origin: 'tests', spec_compliance: {}, engineering: {} } });
    assert.strictEqual(bad.valid, false);
    assert.strictEqual(validateState({ ...base, technical_decisions: [{ ac: 'AC-01', rationale: 'r' }] }).valid, false);
    assert.strictEqual(validateState({ ...base, technical_decisions: [{ ac: 'AC-01', rationale: 'r', approved_at: '2026-09-30T10:00:00Z' }] }).valid, true);
});
