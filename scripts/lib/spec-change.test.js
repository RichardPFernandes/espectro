// node --test scripts/lib/spec-change.test.js
// Governança de decisões do /implement (TECHNICAL_DECISION / SPEC_CLARIFICATION /
// SPEC_CHANGE): classificação + reclassificação forçada, registro em
// technical_decisions[], proposta auditável com pausa, aprovação (spec com Histórico de
// Mudanças, hash novo, artefatos stale, volta ao Plan) e rejeição (segue pausado) —
// unidade + CLI num repo sintético + Review (decision_reviews) + Verify + schema +
// integração com o watcher (runSpecChangeGate via dispatchTicket, fetch stubado e um
// `claude` falso no PATH: nenhum Redmine nem agente real).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const sc = require('./spec-change');
const sa = require('./spec-authority');
const rr = require('./review-result');
const { validateState } = require('../validate-state');

const CLI = path.join(__dirname, 'spec-change.js');
const FILLER = 'Texto descritivo suficiente para passar do limite mínimo de caracteres exigido pela validação. ';
const SPEC = `# Spec 43800

## Problema
${FILLER}Hoje o relatório de fretes não mostra o desconto por volume.

## Solução
${FILLER}Calcular o desconto por volume no serviço de frete.

## Critérios de Aceite
- AC-01: Fretes com mais de 10 volumes recebem 5% de desconto.
- AC-02: O relatório exibe o desconto aplicado por frete.
- AC-03: Exportação CSV inclui a coluna de desconto.

## Restrições
- Não alterar o contrato do endpoint de cotação.
`;

const sandbox = fs.mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'spec-change-'));
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const schema = readJson(path.join(__dirname, '..', '..', '.graph', 'schemas', 'state.schema.json'));
let seq = 0;

/** Run sintético: <root>/memory/runs/<task>/ + <root>/memory/spec/43800-spec.md. */
function seedRun(stateOver = {}, specContent = SPEC) {
    const root = path.join(sandbox, `repo-${++seq}`);
    const taskId = `43800-desconto-${seq}`;
    const dir = path.join(root, 'memory', 'runs', taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(root, 'memory', 'spec'), { recursive: true });
    const specFile = path.join(root, 'memory', 'spec', '43800-spec.md');
    fs.writeFileSync(specFile, specContent);
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
        task_id: taskId, node: 'implement', history: ['fetch_ticket', 'plan'], status: 'in_progress',
        started_at: '2026-09-30T10:00:00.000Z', redmine_ticket: { id: 43800 },
        spec_path: 'memory/spec/43800-spec.md', spec_hash: sa.specHash(specContent), ...stateOver,
    }, null, 2));
    fs.writeFileSync(path.join(dir, 'handoff.md'), '# Handoff\n\n## Referência da Spec\n- Spec: memory/spec/43800-spec.md\n- ACs: AC-01, AC-02, AC-03\n');
    fs.writeFileSync(path.join(dir, 'plan.md'), '# Plano\n\n## Plano de execução\n1. Desconto. Critérios: AC-01, AC-02, AC-03\n');
    fs.writeFileSync(path.join(dir, 'context.md'), '# Contexto\n\nDiagnóstico original.\n');
    return { root, taskId, dir, specFile };
}

function record(dir, input) {
    const file = path.join(dir, `decision-${Date.now()}-${Math.random()}.json`);
    fs.writeFileSync(file, JSON.stringify(input));
    return spawnSync(process.execPath, [CLI, 'record', dir, `--input=${file}`], { encoding: 'utf8' });
}
const stateOf = dir => readJson(path.join(dir, 'state.json'));
const auditOf = dir => readJson(path.join(dir, sc.AUDIT_FILE));

// ── Classificação (pura) ─────────────────────────────────────────────────────────

test('detectSpecChange: verbo sobre o AC / regra de negócio dispara; menção incidental e negação não', () => {
    const cases = [
        ['Removi o helper legado usado pelo AC-01', []],
        ['Usar JOIN em vez de subquery, mesmo resultado observável', []],
        ['Sem alterar a regra de negócio, troquei o cálculo de lugar', []],
        ['Não remove o AC-01: só muda a classe', []],
        ['Remover o AC-02 porque o relatório não tem espaço', ['removes_ac']],
        ['AC-03 fica fora do escopo desta entrega', ['removes_ac']],
        ['Não atender o AC-03 nesta rodada', ['removes_ac']],
        ['AC-01 atendido parcialmente (só acima de 20 volumes)', ['weakens_ac']],
        ['Mudei a regra de negócio: desconto só para clientes ativos', ['changes_business_rule']],
        ['Adicionada exceção para clientes VIP', ['adds_functional_exception']],
    ];
    for (const [text, want] of cases) assert.deepStrictEqual(sc.detectSpecChange({ description: text }), want, text);
});

test('classifyDecision: flag de impacto força SPEC_CHANGE e deriva antes/depois da spec', () => {
    const { errors, decision } = sc.classifyDecision({
        type: 'SPEC_CLARIFICATION', description: 'Desconto passa a valer a partir de 20 volumes', rationale: 'mais simples',
        ac_affected: ['AC-01'], impact: { weakens_ac: true },
    }, { knownAcs: ['AC-01', 'AC-02', 'AC-03'], activeAcs: ['AC-01', 'AC-02', 'AC-03'], acText: new Map([['AC-01', 'Fretes com mais de 10 volumes recebem 5% de desconto.']]), now: '2026-09-30T12:00:00.000Z' });
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(decision.type, 'SPEC_CHANGE');
    assert.strictEqual(decision.declared_type, 'SPEC_CLARIFICATION');
    assert.match(decision.reclassified_reason, /enfraquece AC/);
    assert.deepStrictEqual(decision.ac_affected, ['AC-01']);
    assert.match(decision.previous_behavior, /AC-01: Fretes com mais de 10 volumes/);
    assert.strictEqual(decision.proposed_behavior, 'Desconto passa a valer a partir de 20 volumes');
});

test('classifyDecision: entrada inválida (type, AC inexistente, ac_changes) não grava nada', () => {
    const ctx = { knownAcs: ['AC-01'], activeAcs: ['AC-01'] };
    assert.match(sc.classifyDecision({ type: 'X', description: 'a', rationale: 'b' }, ctx).errors.join(), /type deve ser/);
    assert.match(sc.classifyDecision({ type: 'TECHNICAL_DECISION', description: 'a', rationale: 'b', ac_affected: ['AC-09'] }, ctx).errors.join(), /AC-09 não existe/);
    assert.match(sc.classifyDecision({ type: 'SPEC_CHANGE', description: 'a', rationale: 'b', ac_changes: [{ action: 'replace', ac: 'AC-01' }] }, ctx).errors.join(), /precisa do text/);
    assert.match(sc.classifyDecision({ type: 'TECHNICAL_DECISION', description: '', rationale: '' }, ctx).errors.join(), /description vazio.*rationale vazio/);
});

// ── Testes obrigatórios (CLI num run sintético) ──────────────────────────────────

test('TECHNICAL_DECISION válida → registrada em technical_decisions[] e segue sem pausar', () => {
    const { dir, specFile } = seedRun();
    const r = record(dir, {
        type: 'TECHNICAL_DECISION', description: 'Cálculo do desconto com o helper DescontoUtil existente',
        rationale: 'Reaproveita helper testado; mesmo resultado observável', ac_affected: ['AC-01'],
        timestamp: '2026-09-30T12:00:00.000Z',
    });
    assert.strictEqual(r.status, 0, r.stderr);
    const s = stateOf(dir);
    assert.strictEqual(s.status, 'in_progress');
    assert.strictEqual(s.spec_change_pending, undefined);
    assert.deepStrictEqual(s.technical_decisions, [{
        type: 'TECHNICAL_DECISION', description: 'Cálculo do desconto com o helper DescontoUtil existente',
        rationale: 'Reaproveita helper testado; mesmo resultado observável', agent: 'implement',
        timestamp: '2026-09-30T12:00:00.000Z', ac_affected: ['AC-01'], ac: 'AC-01', approved_at: '2026-09-30T12:00:00.000Z',
    }]);
    assert.ok(!fs.existsSync(path.join(dir, sc.AUDIT_FILE)), 'decisão técnica não vai para o audit de SPEC_CHANGE');
    assert.strictEqual(fs.readFileSync(specFile, 'utf8'), SPEC);
    // Vale como registro para o DOCUMENTED_TECHNICAL_DECISION do Review.
    assert.deepStrictEqual(rr.registeredDecisions(s, null).valid.map(d => d.ac), ['AC-01']);
    assert.ok(validateState(s, schema).valid, JSON.stringify(validateState(s, schema).errors));
});

test('SPEC_CLARIFICATION válida → segue e aparece no Review (decision_reviews + spec_clarifications)', () => {
    const { dir } = seedRun();
    const r = record(dir, {
        type: 'SPEC_CLARIFICATION', description: '"Mais de 10 volumes" interpretado como estritamente maior que 10',
        rationale: 'A spec diz "mais de", compatível; nenhum AC reduzido', ac_affected: ['AC-01'],
    });
    assert.strictEqual(r.status, 0, r.stderr);
    const s = stateOf(dir);
    assert.strictEqual(s.status, 'in_progress');
    assert.strictEqual(s.technical_decisions[0].type, 'SPEC_CLARIFICATION');
    assert.strictEqual(s.technical_decisions[0].approved_at, undefined, 'esclarecimento não é auto-aprovado como decisão técnica');

    const ctx = rr.loadContext(dir);
    assert.strictEqual(ctx.implementDecisions.length, 1);
    assert.ok(rr.template(ctx).decision_reviews, 'template do Review pede a conferência');
    const base = reviewInput();
    // Review que esquece de conferir a decisão = entrada inválida.
    assert.match(rr.evaluate(base, evalCtx(ctx)).errors.join('\n'), /falta conferir a decisão 0/);
    const ok = rr.evaluate({ ...base, decision_reviews: [{ index: 0, alters_behavior: false, reduces_ac: false, note: 'diff usa > 10, como a spec' }] }, evalCtx(ctx));
    assert.deepStrictEqual(ok.errors, []);
    assert.strictEqual(ok.result.verdict, 'PASS');
    assert.strictEqual(ok.result.decision_reviews[0].verdict, 'CONFIRMED');
    assert.ok(ok.result.spec_clarifications.some(c => c.source === 'implement' && c.ac === 'AC-01'));
});

test('agente tenta remover AC (declarado como TECHNICAL_DECISION) → detectado como SPEC_CHANGE, pausa', () => {
    const { dir, specFile } = seedRun();
    const r = record(dir, {
        type: 'TECHNICAL_DECISION', description: 'Remover o AC-03: a exportação CSV não suporta coluna nova',
        rationale: 'Simplifica a entrega', timestamp: '2026-09-30T12:00:00.000Z',
    });
    assert.strictEqual(r.status, 4, r.stdout + r.stderr);
    assert.match(r.stderr, /RECLASSIFICADA/);
    const s = stateOf(dir);
    assert.strictEqual(s.status, sc.PENDING_STATUS);
    assert.strictEqual(s.node, 'implement', 'node não avança para o review');
    const p = s.spec_change_pending;
    assert.strictEqual(p.id, 'SC-001');
    assert.strictEqual(p.type, 'SPEC_CHANGE');
    assert.deepStrictEqual(p.ac_affected, ['AC-03']);
    assert.match(p.previous_behavior, /AC-03: Exportação CSV inclui a coluna de desconto/);
    assert.match(p.proposed_behavior, /Remover o AC-03/);
    assert.strictEqual(p.agent, 'implement');
    assert.strictEqual(p.timestamp, '2026-09-30T12:00:00.000Z');
    assert.strictEqual(p.declared_type, 'TECHNICAL_DECISION');
    assert.ok(s.events.some(e => e.type === 'spec_change_proposed'));
    assert.strictEqual(s.technical_decisions, undefined, 'SPEC_CHANGE não entra em technical_decisions');
    const audit = auditOf(dir);
    assert.strictEqual(audit.entries.length, 1);
    assert.strictEqual(audit.entries[0].event, 'proposed');
    for (const k of ['previous_behavior', 'proposed_behavior', 'rationale', 'agent', 'timestamp', 'ac_affected']) assert.ok(audit.entries[0][k], k);
    assert.match(fs.readFileSync(path.join(dir, 'handoff.md'), 'utf8'), /spec-change-pending:inicio[\s\S]*SC-001[\s\S]*aguardando aprovação humana/);
    assert.strictEqual(fs.readFileSync(specFile, 'utf8'), SPEC, 'o /implement nunca edita a spec');
    assert.ok(validateState(s, schema).valid, JSON.stringify(validateState(s, schema).errors));
    // Segunda proposta com uma pendente: recusada, nada novo no audit.
    const again = record(dir, { type: 'SPEC_CHANGE', description: 'outra', rationale: 'x', impact: { changes_functional_scope: true } });
    assert.strictEqual(again.status, 4);
    assert.match(again.stderr, /já existe SPEC_CHANGE pendente/);
    assert.strictEqual(auditOf(dir).entries.length, 1);
});

test('alteração de regra de negócio → detectada como SPEC_CHANGE, pausa', () => {
    const { dir } = seedRun();
    const byText = record(dir, {
        type: 'TECHNICAL_DECISION', description: 'Mudei a regra de negócio: desconto só para clientes com contrato ativo',
        rationale: 'O cadastro de clientes inativos está sujo',
    });
    assert.strictEqual(byText.status, 4, byText.stderr);
    const s = stateOf(dir);
    assert.strictEqual(s.status, sc.PENDING_STATUS);
    assert.deepStrictEqual(s.spec_change_pending.impact, ['changes_business_rule']);

    const { dir: dir2 } = seedRun();
    const byFlag = record(dir2, {
        type: 'SPEC_CLARIFICATION', description: 'Arredondamento do desconto para cima', rationale: 'evita centavos',
        ac_affected: ['AC-01'], impact: { changes_business_rule: true },
    });
    assert.strictEqual(byFlag.status, 4);
    assert.strictEqual(stateOf(dir2).status, sc.PENDING_STATUS);
});

test('SPEC_CHANGE aprovada → spec auditável, campos corretos no state.json e volta ao Plan (não ao Review)', () => {
    const { dir, specFile } = seedRun({ node: 'implement', retries: { review: 1 } });
    record(dir, {
        type: 'SPEC_CHANGE', description: 'Substituir AC-01: desconto a partir de 20 volumes', rationale: 'Regra comercial nova confirmada pelo cliente',
        ac_affected: ['AC-01'], previous_behavior: 'Desconto de 5% acima de 10 volumes', proposed_behavior: 'Desconto de 5% acima de 20 volumes',
        ac_changes: [{ action: 'replace', ac: 'AC-01', text: 'Fretes com mais de 20 volumes recebem 5% de desconto.' }],
        timestamp: '2026-09-30T12:00:00.000Z',
    });
    assert.strictEqual(stateOf(dir).status, sc.PENDING_STATUS);
    const out = sc.approveSpecChange(dir, { by: 'Ana (Redmine, 2026-09-30T13:00:00Z)', at: '2026-09-30T13:00:00.000Z' });
    assert.ok(out.ok, out.error);

    // Spec: nada apagado — AC-01 marcado como removido, AC-04 novo, entrada no Histórico.
    const spec = fs.readFileSync(specFile, 'utf8');
    for (const line of SPEC.split('\n').filter(l => l.trim() && !l.startsWith('- AC-01'))) assert.ok(spec.includes(line), `linha preservada: ${line}`);
    assert.match(spec, /- AC-01: Fretes com mais de 10 volumes recebem 5% de desconto\. \(removido em 2026-09-30: substituído por AC-04 — SPEC_CHANGE SC-001\)/);
    assert.match(spec, /- AC-04: Fretes com mais de 20 volumes recebem 5% de desconto\. \(adicionado em 2026-09-30: SPEC_CHANGE SC-001, substitui AC-01\)/);
    assert.match(spec, /## Histórico de Mudanças[\s\S]*### SC-001 · 2026-09-30T13:00:00.000Z · aprovado por Ana[\s\S]*- Antes: Desconto de 5% acima de 10 volumes[\s\S]*- Depois: Desconto de 5% acima de 20 volumes/);
    const acs = sa.specAcs(spec).acs;
    assert.deepStrictEqual(acs.filter(a => a.active).map(a => a.id), ['AC-02', 'AC-03', 'AC-04']);

    const s = stateOf(dir);
    const newHash = sa.specHash(spec);
    assert.notStrictEqual(newHash, sa.specHash(SPEC));
    assert.strictEqual(s.spec_change_approved, true);
    assert.strictEqual(s.spec_change_hash, newHash);
    assert.strictEqual(s.spec_hash, newHash);
    assert.deepStrictEqual(s.stale_artifacts, ['plan.md', 'handoff.md', 'acceptance-evidence.json']);
    assert.strictEqual(s.stale_since, '2026-09-30T13:00:00.000Z');
    assert.strictEqual(s.node, 'plan', 'volta para o Plan');
    assert.notStrictEqual(s.node, 'review');
    assert.strictEqual(s.status, 'in_progress');
    assert.strictEqual(s.spec_change_pending, undefined);
    assert.deepStrictEqual(s.ac_ids, ['AC-01', 'AC-02', 'AC-03', 'AC-04']);
    assert.ok(s.events.some(e => e.type === 'spec_change_approved'));
    assert.ok(validateState(s, schema).valid, JSON.stringify(validateState(s, schema).errors));
    // Drift: a spec nova é a aprovada.
    assert.strictEqual(sa.checkDrift(s, { root: sa.rootOfRunDir(dir), taskId: s.task_id }).ok, true);

    // Audit append-only: proposta preservada + aprovação com approved_by/approved_at.
    const audit = auditOf(dir).entries;
    assert.deepStrictEqual(audit.map(e => e.event), ['proposed', 'approved']);
    assert.strictEqual(audit[1].approved_by, 'human');
    assert.strictEqual(audit[1].approved_at, '2026-09-30T13:00:00.000Z');
    assert.strictEqual(audit[1].previous_behavior, audit[0].previous_behavior);
    assert.strictEqual(audit[1].spec_hash_after, newHash);
    // context.md é histórico: intocado.
    assert.strictEqual(fs.readFileSync(path.join(dir, 'context.md'), 'utf8'), '# Contexto\n\nDiagnóstico original.\n');
});

test('SPEC_CHANGE rejeitada → pipeline permanece pausado, spec inalterada, audit preservado', () => {
    const { dir, specFile } = seedRun();
    record(dir, { type: 'TECHNICAL_DECISION', description: 'Remover o AC-02, relatório sem espaço', rationale: 'layout' });
    const out = sc.rejectSpecChange(dir, { by: 'Ana (Redmine)', at: '2026-09-30T14:00:00.000Z', reason: 'o relatório precisa do desconto' });
    assert.ok(out.ok, out.error);
    const s = stateOf(dir);
    assert.strictEqual(s.status, sc.REJECTED_STATUS);
    assert.strictEqual(s.node, 'implement');
    assert.strictEqual(s.spec_change_pending, undefined);
    assert.strictEqual(s.spec_change_rejected.id, 'SC-001');
    assert.strictEqual(s.spec_change_rejected.rejected_by, 'human');
    assert.strictEqual(s.spec_change_approved, undefined);
    assert.strictEqual(s.stale_artifacts, undefined);
    assert.strictEqual(fs.readFileSync(specFile, 'utf8'), SPEC);
    assert.deepStrictEqual(auditOf(dir).entries.map(e => e.event), ['proposed', 'rejected']);
    assert.strictEqual(auditOf(dir).entries[1].rejection_reason, 'o relatório precisa do desconto');
    assert.ok(validateState(s, schema).valid, JSON.stringify(validateState(s, schema).errors));
    // Rejeitada não pode mais ser aprovada (só pendente aprova).
    assert.strictEqual(sc.approveSpecChange(dir, { by: 'x' }).ok, false);
    // E o Verify nunca passa nesse estado.
    assert.ok(sa.verifyRun(dir, s).failures.some(f => f.code === 'SPEC_CHANGE_REJECTED'));
});

test('retorno ao Plan após aprovação: nó guardado com plan.md/handoff.md stale volta pro Plan; regerado sai da lista', () => {
    const { dir } = seedRun();
    record(dir, { type: 'SPEC_CHANGE', description: 'Exportação CSV fora do escopo', rationale: 'outro ticket', ac_changes: [{ action: 'remove', ac: 'AC-03' }] });
    const at = new Date(Date.now() - 60_000).toISOString();
    assert.ok(sc.approveSpecChange(dir, { by: 'Ana', at }).ok);
    const s = stateOf(dir);
    // Alguém (ou um avanço manual) tenta pular para o Review: o portão devolve ao Plan.
    s.node = 'review';
    const gate = sc.staleGate(s, 'review');
    assert.strictEqual(gate.rerouted, true);
    assert.strictEqual(s.node, 'plan');
    assert.ok(s.events.some(e => e.type === 'stale_artifacts_replan'));
    // Só reescrever o arquivo não é regerar: a validade decide (scripts/invalidate.js).
    fs.writeFileSync(path.join(dir, 'plan.md'), '# Plano novo\n');
    fs.writeFileSync(path.join(dir, 'handoff.md'), '# Handoff novo\n');
    assert.strictEqual(sc.refreshStale(s, dir), false, 'plan.md reescrito sem baseline continua stale');
    // O /plan regera de verdade: baseline carimba o plano novo VALID → plan.md/handoff.md saem.
    sa.applyBaseline(s, { root: sa.rootOfRunDir(dir), specPath: s.spec_path, taskId: s.task_id });
    assert.strictEqual(sc.refreshStale(s, dir), true);
    assert.deepStrictEqual(s.stale_artifacts, ['acceptance-evidence.json']);
    assert.strictEqual(sc.staleGate(s, 'implement').proceed, true, 'com o HOW regerado, implement segue');
    assert.ok(sa.verifyRun(dir, s).failures.some(f => f.code === 'STALE_ARTIFACTS'), 'Verify reprova com matriz stale');
    fs.writeFileSync(path.join(dir, 'acceptance-evidence.json'), '{}');
    assert.strictEqual(sc.refreshStale(s, dir), false, 'matriz reescrita sem finalize continua stale');
    require('../invalidate').stampProduced(s, 'evidence', { specHash: s.spec_hash, runDir: dir }); // o que o finalize do /test faz
    assert.strictEqual(sc.refreshStale(s, dir), true);
    assert.strictEqual(s.stale_artifacts, undefined);
    assert.strictEqual(s.stale_since, undefined);
    // AC-03 removido com a marca (nunca apagado).
    assert.match(fs.readFileSync(path.join(sa.rootOfRunDir(dir), 'memory/spec/43800-spec.md'), 'utf8'), /- AC-03: Exportação CSV inclui a coluna de desconto\. \(removido em \d{4}-\d{2}-\d{2}: SPEC_CHANGE SC-001\)/);
});

test('Verify reprova com SPEC_CHANGE pendente', () => {
    const { dir } = seedRun();
    record(dir, { type: 'SPEC_CHANGE', description: 'Nova exceção', rationale: 'x', impact: { adds_functional_exception: true } });
    assert.ok(sa.verifyRun(dir, stateOf(dir)).failures.some(f => f.code === 'SPEC_CHANGE_PENDING'));
});

test('Histórico de Mudanças: segunda SPEC_CHANGE aprovada acrescenta, nunca reescreve a primeira', () => {
    const { dir, specFile } = seedRun();
    record(dir, { type: 'SPEC_CHANGE', description: 'Exportação CSV fora do escopo', rationale: 'outro ticket', ac_changes: [{ action: 'remove', ac: 'AC-03' }] });
    sc.approveSpecChange(dir, { by: 'Ana', at: '2026-09-30T13:00:00.000Z' });
    const first = fs.readFileSync(specFile, 'utf8');
    const s = stateOf(dir);
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ ...s, node: 'implement', status: 'in_progress' }));
    record(dir, { type: 'SPEC_CHANGE', description: 'Adicionar AC de auditoria', rationale: 'compliance', ac_changes: [{ action: 'add', text: 'Desconto aplicado fica registrado no log de auditoria.' }] });
    assert.strictEqual(stateOf(dir).spec_change_pending.id, 'SC-002');
    sc.approveSpecChange(dir, { by: 'Bia', at: '2026-09-30T15:00:00.000Z' });
    const second = fs.readFileSync(specFile, 'utf8');
    const history = second.slice(second.indexOf('## Histórico de Mudanças'));
    assert.ok(history.includes(first.slice(first.indexOf('### SC-001')).trim()), 'entrada SC-001 intacta');
    assert.ok(history.indexOf('### SC-001') < history.indexOf('### SC-002'));
    assert.match(second, /- AC-04: Desconto aplicado fica registrado no log de auditoria\./);
    assert.strictEqual((second.match(/## Histórico de Mudanças/g) || []).length, 1);
    assert.deepStrictEqual(auditOf(dir).entries.map(e => `${e.id}:${e.event}`), ['SC-001:proposed', 'SC-001:approved', 'SC-002:proposed', 'SC-002:approved']);
});

// ── Review (Task 64): classificação errada do /implement reprova ─────────────────

function reviewInput() {
    return {
        spec_compliance: {
            acs: ['AC-01', 'AC-02', 'AC-03'].map(id => ({ id, result: 'PASS', evidence: `FreteService.java:10 (${id})` })),
            checks: Object.fromEntries(rr.SPEC_CHECKS.map(c => [c.key, { result: 'PASS', note: 'conferido' }])),
        },
        divergences: [],
        engineering: { items: rr.CHECKLIST.map(c => ({ n: c.n, result: 'PASS', note: 'ok' })), findings: [] },
        observations: [],
    };
}
const evalCtx = ctx => ({ activeAcs: ctx.activeAcs, knownAcs: ctx.knownAcs, specApplies: ctx.specApplies, decisions: ctx.decisions.valid, implementDecisions: ctx.implementDecisions });

test('Review: TECHNICAL_DECISION que altera comportamento → reprova como SPEC_CHANGE_REQUIRED', () => {
    const { dir } = seedRun();
    assert.strictEqual(record(dir, { type: 'TECHNICAL_DECISION', description: 'Cache do cálculo de desconto por cliente', rationale: 'performance', ac_affected: ['AC-01'] }).status, 0);
    const ctx = rr.loadContext(dir);
    const { errors, result } = rr.evaluate({ ...reviewInput(), decision_reviews: [{ index: 0, alters_behavior: true, reduces_ac: false, note: 'cache de 1h faz o desconto antigo valer depois da troca de faixa', file: 'FreteService.java', line: 42 }] }, evalCtx(ctx));
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(result.verdict, 'FAIL');
    assert.strictEqual(result.failure_origin, 'spec_compliance');
    const d = result.divergences.find(x => x.declared_classification === 'TECHNICAL_DECISION');
    assert.strictEqual(d.classification, 'SPEC_CHANGE_REQUIRED');
    assert.match(d.reclassified_reason, /altera comportamento funcional/);
    assert.strictEqual(result.decision_reviews[0].verdict, 'SPEC_CHANGE_REQUIRED');
    assert.ok(result.findings.some(f => f.category === 'SPEC_CHANGE_REQUIRED' && f.ac === 'AC-01' && f.file === 'FreteService.java'));
});

test('Review: SPEC_CLARIFICATION que reduz AC → reprova como SPEC_CHANGE_REQUIRED', () => {
    const { dir } = seedRun();
    // Passou pelo registro (texto inocente), mas o diff reduz o critério.
    assert.strictEqual(record(dir, { type: 'SPEC_CLARIFICATION', description: '"Desconto aplicado" entendido como o desconto total do relatório', rationale: 'spec ambígua', ac_affected: ['AC-02'] }).status, 0);
    const ctx = rr.loadContext(dir);
    const { errors, result } = rr.evaluate({ ...reviewInput(), decision_reviews: [{ index: 0, alters_behavior: false, reduces_ac: true, note: 'AC-02 pede o desconto por frete; o diff mostra só o total' }] }, evalCtx(ctx));
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(result.verdict, 'FAIL');
    const d = result.divergences.find(x => x.declared_classification === 'SPEC_CLARIFICATION');
    assert.strictEqual(d.classification, 'SPEC_CHANGE_REQUIRED');
    assert.match(d.reclassified_reason, /reduz AC/);
    assert.ok(!result.spec_clarifications.some(c => c.source === 'implement'), 'esclarecimento reprovado não segue para o Verify');
    // record grava no state o resultado (schema aceita decision_reviews).
    const review = rr.record(dir, ctx, result, '2026-09-30T16:00:00.000Z');
    assert.strictEqual(stateOf(dir).review_results.decision_reviews[0].verdict, 'SPEC_CHANGE_REQUIRED');
    assert.match(fs.readFileSync(path.join(dir, rr.RESULT_FILE), 'utf8'), /Decisões do \/implement[\s\S]*SPEC_CHANGE_REQUIRED/);
    assert.ok(review);
    assert.ok(validateState(stateOf(dir), schema).valid, JSON.stringify(validateState(stateOf(dir), schema).errors));
});

// ── Integração com o watcher ─────────────────────────────────────────────────────

const tmp = fs.mkdtempSync(path.join(sandbox, 'watcher-'));
const repo = path.join(tmp, 'app-back');
const binDir = path.join(tmp, 'bin');
const claudeCalls = path.join(tmp, 'claude-calls.log');
fs.mkdirSync(repo, { recursive: true });
fs.mkdirSync(binDir);
fs.writeFileSync(path.join(binDir, 'claude'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${claudeCalls}'\n`, { mode: 0o755 });
process.env.REPO_PATH = repo;
process.env.REDMINE_URL = 'http://redmine.test';
process.env.REDMINE_API_KEY = 'k';
process.env.SPEC_AUTO_REPAIR = '0';
process.env.SKIP_PRE_BUILD_VALIDATION = 'true';
process.env.PATH = `${binDir}:${process.env.PATH}`;

// Redmine falso: PUT vira journal (o comentário do watcher), GET devolve os journals.
const journals = new Map(); // ticketId -> [{id, notes, user, created_on}]
const redminePuts = [];
let journalSeq = 1000;
function addJournal(id, notes, user = 'Watcher') {
    const list = journals.get(id) || [];
    list.push({ id: ++journalSeq, notes, user: { name: user }, created_on: new Date().toISOString() });
    journals.set(id, list);
}
global.fetch = async (url, opts = {}) => {
    const id = Number((/issues\/(\d+)\.json/.exec(url) || [])[1]);
    if (opts.method === 'PUT') {
        const body = JSON.parse(opts.body);
        redminePuts.push({ id, body });
        addJournal(id, body.issue.notes);
    }
    return { ok: true, status: 200, json: async () => ({ issue: { id, journals: journals.get(id) || [] } }) };
};

const watcher = require('../readmine-watcher');

function ticket(id) {
    return {
        id, subject: `Ticket ${id}`, description: SPEC, status: { name: 'Aprovada' }, tracker: { name: 'Melhoria' },
        custom_fields: [{ name: 'Branch Liberação', value: 'Dev - Local' }], updated_on: new Date().toISOString(),
    };
}

/** Task no worktree do ticket, com o /implement já tendo registrado uma SPEC_CHANGE. */
function seedPendingTask(id, decision) {
    const wt = path.join(repo, '.claude', 'worktrees', String(id));
    const taskId = `${id}-teste`;
    const dir = path.join(wt, 'memory', 'runs', taskId);
    const specRel = `memory/spec/${id}-spec.md`;
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(wt, 'memory', 'spec'), { recursive: true });
    fs.writeFileSync(path.join(wt, specRel), SPEC);
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
        task_id: taskId, node: 'implement', history: ['fetch_ticket', 'plan'], status: 'in_progress',
        started_at: new Date().toISOString(), redmine_ticket: { id }, ac_ids: ['AC-01', 'AC-02', 'AC-03'],
        spec_path: specRel, spec_hash: sa.specHash(SPEC),
    }));
    fs.writeFileSync(path.join(dir, 'handoff.md'), `# Handoff\n- Spec: ${specRel}\n- ACs: AC-01, AC-02, AC-03\n`);
    fs.writeFileSync(path.join(dir, 'plan.md'), '# Plano\n');
    const r = sc.recordDecision(dir, decision);
    assert.strictEqual(r.paused, true);
    return { taskId, dir, spec: path.join(wt, specRel) };
}

async function waitFor(pred) {
    for (let i = 0; i < 100; i++) { if (pred()) return true; await new Promise(r => setTimeout(r, 50)); }
    return false;
}
const claudeLog = () => (fs.existsSync(claudeCalls) ? fs.readFileSync(claudeCalls, 'utf8') : '');

test('watcher: SPEC_CHANGE pendente → publica a proposta no Redmine uma vez e não despacha nada', async () => {
    const { taskId, dir } = seedPendingTask(93001, { type: 'TECHNICAL_DECISION', description: 'Remover o AC-03, CSV sem coluna', rationale: 'layout' });
    const r = await watcher.dispatchTicket(ticket(93001));
    assert.strictEqual(r.action, 'skip');
    assert.strictEqual(r.reason, 'spec_change_aguardando_aprovacao');
    const puts = redminePuts.filter(p => p.id === 93001);
    assert.strictEqual(puts.length, 1);
    assert.ok(puts[0].body.issue.notes.startsWith(watcher.SPEC_CHANGE_COMMENT_PREFIX));
    assert.match(puts[0].body.issue.notes, /AC-03[\s\S]*Comportamento proposto[\s\S]*aprovado[\s\S]*rejeitado/);
    const s = stateOf(dir);
    assert.strictEqual(s.status, sc.PENDING_STATUS);
    assert.ok(s.spec_change_pending.posted_at);
    assert.strictEqual(s.spec_change_pending.comment_id, journalSeq);
    // Tick seguinte sem resposta: continua pausado, sem novo comentário.
    assert.strictEqual((await watcher.dispatchTicket(ticket(93001))).reason, 'spec_change_aguardando_aprovacao');
    assert.strictEqual(redminePuts.filter(p => p.id === 93001).length, 1);
    assert.ok(!new RegExp(`${taskId}`).test(claudeLog()), 'nenhum nó despachado');
});

test('watcher: "aprovado" no Redmine → spec atualizada e /plan despachado (não /review)', async () => {
    const { taskId, dir, spec } = seedPendingTask(93002, {
        type: 'SPEC_CHANGE', description: 'Exportação CSV fora do escopo', rationale: 'vai em outro ticket', ac_changes: [{ action: 'remove', ac: 'AC-03' }],
    });
    await watcher.dispatchTicket(ticket(93002)); // publica
    addJournal(93002, 'aprovado\n\n(aprovado pelo dashboard local)', 'Ana');
    const r = await watcher.dispatchTicket(ticket(93002));
    assert.strictEqual(r.action, 'dispatched', JSON.stringify(r));
    assert.strictEqual(r.node, 'plan');
    assert.ok(await waitFor(() => new RegExp(`/plan ${taskId}`).test(claudeLog())), claudeLog());
    assert.ok(!new RegExp(`/review ${taskId}`).test(claudeLog()));
    const content = fs.readFileSync(spec, 'utf8');
    assert.match(content, /## Histórico de Mudanças[\s\S]*SC-001[\s\S]*aprovado por Ana/);
    assert.match(content, /AC-03: .*\(removido em/);
    await waitFor(() => stateOf(dir).status === 'in_progress');
    const s = stateOf(dir);
    assert.strictEqual(s.spec_change_approved, true);
    assert.strictEqual(s.spec_change_hash, sa.specHash(content));
    assert.deepStrictEqual(s.stale_artifacts, ['plan.md', 'handoff.md', 'acceptance-evidence.json']);
    assert.deepStrictEqual(auditOf(dir).entries.map(e => e.event), ['proposed', 'approved']);
    assert.match(auditOf(dir).entries[1].approver, /^Ana \(Redmine/);
    // EC-4: o journal da proposta (postado pelo watcher) e o da resposta "aprovado" são
    // distintos e gravados separados; a provenance do AC-03 leva os dois.
    const approved = auditOf(dir).entries[1];
    const approvalJournal = journals.get(93002).find(j => /^aprovado/.test(j.notes));
    assert.strictEqual(approved.approval_journal_id, approvalJournal.id);
    assert.strictEqual(approved.proposal_comment_id, approved.comment_id);
    assert.notStrictEqual(approved.proposal_comment_id, approved.approval_journal_id);
    const acProvenance = require('./ac-provenance');
    const log = acProvenance.readLog('93002', { root: acProvenance.provenanceRoot(path.resolve(dir, '..', '..', '..')) }).data;
    const [ev] = acProvenance.sourcesFor(log, 'AC-03');
    assert.strictEqual(ev.type, 'SPEC_CHANGE');
    assert.strictEqual(ev.role, 'MODIFICATION');
    assert.strictEqual(ev.reference.action, 'remove');
    assert.strictEqual(ev.reference.approval_journal_id, approvalJournal.id);
    assert.strictEqual(ev.reference.proposal_comment_id, approved.comment_id);
});

test('watcher: "rejeitado" no Redmine → spec intacta, task pausada em spec-change-rejected', async () => {
    const { taskId, dir, spec } = seedPendingTask(93003, { type: 'TECHNICAL_DECISION', description: 'Mudei a regra de negócio do desconto', rationale: 'x' });
    await watcher.dispatchTicket(ticket(93003));
    addJournal(93003, 'rejeitado — o desconto continua como na spec', 'Ana');
    const r = await watcher.dispatchTicket(ticket(93003));
    assert.strictEqual(r.action, 'skip');
    assert.strictEqual(r.reason, 'spec_change_rejeitada');
    assert.strictEqual(fs.readFileSync(spec, 'utf8'), SPEC);
    const s = stateOf(dir);
    assert.strictEqual(s.status, sc.REJECTED_STATUS);
    assert.match(s.spec_change_rejected.rejection_reason, /o desconto continua como na spec/);
    // Ticks seguintes: continua pausado.
    assert.strictEqual((await watcher.dispatchTicket(ticket(93003))).reason, 'spec_change_rejeitada');
    assert.ok(!new RegExp(`${taskId}`).test(claudeLog()));
});

test('watcher: resposta anterior ao comentário da proposta não conta', async () => {
    const id = 93004;
    addJournal(id, 'aprovado', 'Ana'); // aprovação antiga (de outro pedido)
    const { dir } = seedPendingTask(id, { type: 'SPEC_CHANGE', description: 'Nova exceção para VIP', rationale: 'x', impact: { adds_functional_exception: true } });
    await watcher.dispatchTicket(ticket(id)); // publica
    assert.strictEqual((await watcher.dispatchTicket(ticket(id))).reason, 'spec_change_aguardando_aprovacao');
    assert.strictEqual(stateOf(dir).status, sc.PENDING_STATUS);
});
