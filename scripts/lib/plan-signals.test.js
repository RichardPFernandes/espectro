// node --test scripts/lib/plan-signals.test.js
// PRI-222 (PRI-205 S2): sinais prospectivos/retrospectivos, só observacionais.
// Fixtures sintéticas. Cada linha da tabela do §4.5 do desenho v9 vira um caso, mas o
// que se afirma são os SINAIS (kind, schema_decl, n_services_decl, code_local...):
// a classe C1–C5 é da S3 e não existe aqui.
const test = require('node:test');
const assert = require('node:assert');
const ps = require('./plan-signals');

const U = 'UNKNOWN';

function plan(...steps) {
    return '# Plano — t\n\n## Plano de execução\n' + steps.map((s, i) => {
        const lines = [`${i + 1}. ${s.title || 'Passo'}`];
        if (s.files !== null) lines.push(`   - Arquivo: ${s.files}`);
        if (s.acs !== null) lines.push(`   - Critérios: ${(s.acs || ['AC-01']).join(', ')}`);
        lines.push('   - Verificação: teste.');
        return lines.join('\n');
    }).join('\n') + '\n\n## Cobertura dos ACs\n- AC-01 → passos 1\n';
}
const tick = (...p) => p.map(x => '`' + x + '`').join(', ');
const SPEC = '## Critérios de Aceite\n- AC-01: lista de transportadoras.\n- AC-02: mensagem de erro.\n- AC-03: ordenação.\n- AC-04: filtro.\n';

function signalsOf(steps, ctx = {}) {
    const r = ps.buildProspective(plan(...steps), { specContent: SPEC, fileExists: () => true, ...ctx });
    assert.strictEqual(r.status, 'COMPLETE');
    return r;
}
const first = (steps, ctx) => signalsOf(steps, ctx).groups[0].signals;

// --- extração, plan_version e agrupamento (D14) ---------------------------------

test('plan_version: sha256 do bloco normalizado; espaços/quebras não mudam; conteúdo muda', () => {
    const a = ps.extractPlanSteps(plan({ files: tick('a.js') }));
    const b = ps.extractPlanSteps(plan({ files: tick('a.js') }).replace(/\n   - /g, '\n      -   '));
    const c = ps.extractPlanSteps(plan({ files: tick('b.js') }));
    assert.match(a.plan_version, /^[0-9a-f]{64}$/);
    assert.strictEqual(a.plan_version, b.plan_version);
    assert.notStrictEqual(a.plan_version, c.plan_version);
});

test('plan_version ignora seções fora do bloco de plano', () => {
    const base = plan({ files: tick('a.js') });
    assert.strictEqual(ps.extractPlanSteps(base).plan_version, ps.extractPlanSteps(base + '\n## Riscos técnicos\n- Perfil: G1\n').plan_version);
});

test('agrupamento: fecho transitivo por arquivo em comum; sem Arquivo vira grupo próprio; subtask_key estável', () => {
    const r = signalsOf([
        { files: tick('a.js', 'b.js') },        // 1
        { files: tick('c.js') },                // 2
        { files: tick('b.js', 'd.js') },        // 3 liga a 1
        { files: null },                        // 4 sem Arquivo
        { files: tick('d.js', 'e.js') },        // 5 liga a 3 (transitivo)
    ]);
    assert.deepStrictEqual(r.groups.map(g => g.steps), [[1, 3, 5], [2], [4]]);
    assert.strictEqual(r.groups[0].subtask_key, `${r.plan_version.slice(0, 12)}/1-5`);
    assert.strictEqual(r.groups[1].subtask_key, `${r.plan_version.slice(0, 12)}/2-2`);
    assert.strictEqual(r.groups[2].signals.paths_decl, U);
    assert.strictEqual(r.groups[2].signals.n_files, U);
    assert.strictEqual(r.groups[2].signals.kind, U);
    // Mesma entrada => mesmas chaves.
    assert.deepStrictEqual(signalsOf([{ files: tick('a.js') }]).groups[0].subtask_key, signalsOf([{ files: tick('a.js') }]).groups[0].subtask_key);
});

test('Arquivo não parseável (placeholder "...", curinga, vazio) => paths_decl UNKNOWN, nunca lista vazia', () => {
    for (const files of ['`app/src/.../X.java`', '`src/*.js`', 'a definir', '']) {
        const s = first([{ files }]);
        assert.strictEqual(s.paths_decl, U, files);
        assert.strictEqual(s.schema_decl, U);
        assert.strictEqual(s.n_services_decl, U);
    }
});

test('F1: mais de uma linha "Arquivo:" no passo => paths_decl UNKNOWN (nunca lista parcial)', () => {
    const text = '## Plano de execução\n1. a\n   - Arquivo: `a.js`\n   - Arquivo: `b.js`\n   - Critérios: AC-01\n   - Verificação: t.\n' +
        '2. b\n   - Arquivo: `b.js`\n   - Critérios: AC-01\n   - Verificação: t.\n';
    const r = ps.buildProspective(text, { specContent: SPEC, fileExists: () => true });
    assert.strictEqual(r.groups[0].signals.paths_decl, U);
    assert.strictEqual(r.groups[0].signals.n_files, U);
    assert.strictEqual(r.groups[0].signals.schema_decl, U);
    assert.strictEqual(ps.declaredUnion(r), U, 'sem declarado completo, o retrospectivo não conclui violação');
});

test('F4: sufixo de posição é aparado; diretório e curinga viram UNKNOWN', () => {
    assert.deepStrictEqual(first([{ files: tick('scripts/x.js:42') }]).paths_decl, ['scripts/x.js']);
    assert.deepStrictEqual(first([{ files: tick('scripts/x.js:42-50') }]).paths_decl, ['scripts/x.js']);
    assert.deepStrictEqual(first([{ files: tick('backend/x/A.java::metodo') }]).paths_decl, ['backend/x/A.java']);
    assert.strictEqual(first([{ files: tick('backend/svc/src/') }]).paths_decl, U);
    assert.strictEqual(first([{ files: tick('a.js', 'backend/svc/') }]).paths_decl, U);
});

test('R1: lista dentro de uma única crase => UNKNOWN (nunca um caminho fantasma)', () => {
    for (const f of ['`a.js, b.js`', '`a.js; b.js`', '`a.js e b.js`']) {
        assert.strictEqual(first([{ files: f }]).paths_decl, U, f);
    }
    // migração + código na mesma crase: não pode sair kind=code / schema_decl=false.
    const s = first([{ files: '`backend/svc-a/src/main/resources/db/migration/V1__x.sql, backend/svc-a/src/a.js`' }]);
    assert.deepStrictEqual([s.paths_decl, s.kind, s.schema_decl], [U, U, U]);
    // nome com espaço continua aceito.
    assert.deepStrictEqual(first([{ files: '`docs/meu arquivo.js`' }]).paths_decl, ['docs/meu arquivo.js']);
});

test('R2: diretório seguido de parêntese => UNKNOWN', () => {
    assert.strictEqual(first([{ files: '`backend/svc/ (novo)`' }]).paths_decl, U);
    assert.strictEqual(first([{ files: 'backend/svc/ (novo)' }]).paths_decl, U);
});

test('plano sem bloco => status UNKNOWN com causa, sem grupos', () => {
    const r = ps.buildProspective('# nada aqui\n', {});
    assert.deepStrictEqual([r.status, r.cause, r.plan_version, r.groups], ['UNKNOWN', 'PLAN_BLOCK_NOT_FOUND', U, []]);
});

// --- linhas da tabela do §4.5 (DV03) --------------------------------------------

test('§4.5 [classe v9: C4; não computada]: 3 arquivos, 1 serviço, 4 ACs => n_files 3, n_acs_step 4, code_local', () => {
    const s = first([{ files: tick('backend/svc-a/src/a.js', 'backend/svc-a/src/b.js', 'backend/svc-a/src/c.js'), acs: ['AC-01', 'AC-02', 'AC-03', 'AC-04'] }]);
    assert.deepStrictEqual([s.n_files, s.n_acs_step, s.n_services_decl, s.code_local, s.schema_decl, s.sensitive_decl, s.rework_count, s.ticket_rework],
        [3, 4, 1, true, false, false, 0, false]);
});

test('§4.5 [classe v9: C1; não computada]: README.md com AC-01 => kind docs, n_services 0', () => {
    const s = first([{ files: tick('README.md') }]);
    assert.deepStrictEqual([s.kind, s.n_files, s.n_acs_step, s.n_services_decl, s.code_local], ['docs', 1, 1, 0, false]);
});

test('§4.5 [classe v9: C4; não computada]: .claude/commands/plan.md é behavior, nunca docs', () => {
    assert.strictEqual(first([{ files: tick('.claude/commands/plan.md') }]).kind, 'behavior');
    assert.strictEqual(first([{ files: tick('AGENTS.md') }]).kind, 'behavior');
    assert.strictEqual(first([{ files: tick('docs/handoff-contract.md') }]).kind, 'behavior');
    assert.strictEqual(first([{ files: tick('docs/guia.md') }]).kind, 'docs');
});

test('§4.5 [classe v9: C2; não computada]: js + teste em 1 serviço, 1 arquivo novo => code, 1 bucket, schema_decl false, n_new_files 1', () => {
    const s = first([{ files: tick('backend/svc-a/src/x.js', 'backend/svc-a/test/x.test.js'), acs: ['AC-01', 'AC-02'] }],
        { fileExists: p => p !== 'backend/svc-a/test/x.test.js' });
    assert.deepStrictEqual([s.kind, s.service_buckets, s.n_services_decl, s.schema_decl, s.code_local, s.n_new_files, s.n_acs_step],
        ['code', ['service:backend/svc-a'], 1, false, true, 1, 2]);
});

test('§4.5 [classe v9: C4; não computada] / D18: .java (inclusive teste) => schema_decl true e kind schema', () => {
    const s = first([{ files: tick('backend/svc-a/src/main/java/X.java', 'backend/svc-a/src/test/java/XTest.java') }]);
    assert.deepStrictEqual([s.schema_decl, s.kind, s.code_local], [true, 'schema', false]);
});

test('§4.5 [classe v9: C4; não computada]: dois serviços => 2 buckets', () => {
    const s = first([{ files: tick('backend/svc-a/src/a.js', 'backend/svc-b/src/b.js') }]);
    assert.deepStrictEqual([s.service_buckets, s.n_services_decl, s.code_local],
        [['service:backend/svc-a', 'service:backend/svc-b'], 2, false]);
});

test('§4.5 [classe v9: C4; não computada]: dois serviços + arquivo na raiz => 3 buckets (__root__ conta; não usa analyzeChangedFiles)', () => {
    const s = first([{ files: tick('backend/svc-a/src/a.js', 'backend/svc-b/src/b.js', 'root.js') }]);
    assert.deepStrictEqual([s.service_buckets, s.n_services_decl], [['__root__', 'service:backend/svc-a', 'service:backend/svc-b'], 3]);
});

test('§4.5 [classe v9: C4; não computada]: serviço + scripts/ => 2 buckets (analyzeChangedFiles ignoraria scripts/)', () => {
    const s = first([{ files: tick('backend/svc-a/src/a.js', 'scripts/x.js') }]);
    assert.deepStrictEqual([s.service_buckets, s.n_services_decl], [['__root__', 'service:backend/svc-a'], 2]);
});

test('§4.5 [classe v9: C2; não computada]: docs não conta bucket', () => {
    const s = first([{ files: tick('backend/svc-a/src/a.js', 'backend/svc-a/README.md') }]);
    assert.deepStrictEqual([s.service_buckets, s.n_services_decl, s.kind, s.code_local], [['service:backend/svc-a'], 1, 'code', true]);
});

test('§4.5 [classe v9: C4; não computada]: topologia não declarada => n_services_decl e code_local UNKNOWN', () => {
    const s = first([{ files: tick('backend/svc-a/src/a.js') }], { policy: { ...ps.DEFAULT_POLICY, service_roots: [] } });
    assert.deepStrictEqual([s.n_services_decl, s.service_buckets, s.code_local], [U, U, U]);
});

test('§4.5 [classe v9: C4; não computada]: application.yml sozinho => config', () => {
    assert.strictEqual(first([{ files: tick('backend/svc-a/src/main/resources/application.yml') }]).kind, 'config');
});

test('§4.5 [classe v9: C4 (C5 com schema_risk_seen=high); não computada]: migração Flyway => schema_decl true; persistence.xml também', () => {
    for (const f of ['backend/svc-a/src/main/resources/db/migration/V12__add_col.sql', 'backend/svc-a/src/main/resources/META-INF/persistence.xml']) {
        const s = first([{ files: tick(f) }]);
        assert.deepStrictEqual([s.schema_decl, s.kind], [true, 'schema'], f);
    }
});

test('§4.5 [classe v9: C5 quando high; não computada]: schema_risk_seen vem do state (sobe); sem observação é null', () => {
    assert.strictEqual(first([{ files: tick('a.js') }]).schema_risk_seen, null);
    assert.strictEqual(first([{ files: tick('a.js') }], { state: { schema_risk_level: 'high' } }).schema_risk_seen, 'high');
});

test('§4.5 [classe v9: C5; não computada]: AC referenciado com "autenticação" => sensitive_decl true', () => {
    const spec = '## Critérios de Aceite\n- AC-01: exige autenticação do usuário (auth) antes de listar.\n';
    const s = first([{ files: tick('backend/svc-a/src/a.js') }], { specContent: spec });
    assert.strictEqual(s.sensitive_decl, true);
});

test('sensitive_decl: caminho em sensitive_globs e termo no texto do passo', () => {
    assert.strictEqual(first([{ files: tick('backend/svc-a/src/auth/Login.js') }]).sensitive_decl, true);
    assert.strictEqual(first([{ title: 'Validar o token do usuário', files: tick('backend/svc-a/src/a.js') }]).sensitive_decl, true);
});

test('§4.5 [classe v9: C4; não computada]: AC referenciado inexistente na spec => sensitive_decl UNKNOWN (nunca false)', () => {
    const s = first([{ files: tick('backend/svc-a/src/a.js'), acs: ['AC-99'] }]);
    assert.strictEqual(s.sensitive_decl, U);
    // Sem spec nenhuma: também UNKNOWN.
    assert.strictEqual(first([{ files: tick('a.js'), acs: ['AC-01'] }], { specContent: '' }).sensitive_decl, U);
});

test('§4.5 [classe v9: C4; não computada]: passo sem Arquivo => sinais de caminho UNKNOWN (não false/0)', () => {
    const s = first([{ files: null }]);
    assert.deepStrictEqual([s.paths_decl, s.n_files, s.n_new_files, s.kind, s.n_services_decl, s.schema_decl, s.code_local],
        [U, U, U, U, U, U, U]);
});

test('§4.5 [classe v9: C4; não computada]: arquivo em **/shared/** não é code_local', () => {
    const s = first([{ files: tick('backend/svc-a/src/shared/util.js') }]);
    assert.deepStrictEqual([s.kind, s.n_services_decl, s.code_local], ['code', 1, false]);
});

test('n_acs_step: sem Critérios e kind != test => UNKNOWN; passo só de teste => 0 válido', () => {
    assert.strictEqual(first([{ files: tick('backend/svc-a/src/a.js'), acs: null }]).n_acs_step, U);
    assert.strictEqual(first([{ files: tick('backend/svc-a/test/a.test.js'), acs: null }]).n_acs_step, 0);
    assert.strictEqual(first([{ files: tick('a.js'), acs: ['AC-01', 'AC-01', 'AC-02'] }]).n_acs_step, 2);
});

test('n_new_files: fileExists que lança => UNKNOWN; sem fileExists => UNKNOWN', () => {
    assert.strictEqual(first([{ files: tick('a.js') }], { fileExists: () => { throw new Error('x'); } }).n_new_files, U);
    assert.strictEqual(first([{ files: tick('a.js') }], { fileExists: undefined }).n_new_files, U);
});

test('kind: maior natureza vence (sensitive > schema > behavior > config > code > test > docs)', () => {
    assert.strictEqual(ps.maxKind(['docs', 'test', 'code']), 'code');
    assert.strictEqual(ps.maxKind(['docs', 'config', 'code']), 'config');
    assert.strictEqual(ps.maxKind(['docs', 'behavior', 'schema']), 'schema');
    assert.strictEqual(ps.maxKind(['schema', 'sensitive']), 'sensitive');
});

test('rework: ticket_rework por Recusa QA, planAttempts ou retries do implement; rework_count por subtask_key anterior', () => {
    const steps = [{ files: tick('a.js') }];
    assert.strictEqual(first(steps, { isRecusaQA: true }).ticket_rework, true);
    assert.strictEqual(first(steps, { state: { planAttempts: 1 } }).ticket_rework, true);
    assert.strictEqual(first(steps, { state: { retries: { implement: 1 } } }).ticket_rework, true);
    const key = signalsOf(steps).groups[0].subtask_key;
    const ct = { nodes: { implement: { attempts: [{ signals: { groups: [{ subtask_key: key }] } }, { signals: 'UNAVAILABLE' }, { signals: { groups: [{ subtask_key: 'outra' }] } }] } } };
    assert.strictEqual(first(steps, { costTracking: ct }).rework_count, 1);
});

// --- retrospectivos -------------------------------------------------------------

const AFF = { services: ['backend/svc-a'], fullSuite: false };
const SCH = { detected: false, riskLevel: null };

test('retrospectivo completo: declarado × tocado, sem violação; artefatos de fluxo excluídos', () => {
    const r = ps.retrospectiveSignals({
        changedFiles: ['backend/svc-a/src/a.js', 'memory/runs/1-x/plan.md', 'memory/spec/1-spec.md'],
        diffStat: { added: 10, removed: 2 }, affected: AFF, schema: SCH,
        declaredPaths: ['backend/svc-a/src/a.js'], state: { risk_level: 'low' },
    });
    assert.deepStrictEqual(r, {
        status: 'COMPLETE', files_touched: 1, files_declared: 1, undeclared_files: 0, scope_violation: false,
        affected_services: ['backend/svc-a'], full_suite: false, schema_changes_detected: false, schema_risk_level: null,
        diff_lines_added: 10, diff_lines_removed: 2, risk_level_seen: 'low', tokens_vs_p90: 'UNAVAILABLE',
    });
});

test('§4.5 última linha [classe v9: próximo Attempt ≥ C4; não computada]: diff com arquivo não declarado => scope_violation true (só conta; sem lista de caminhos)', () => {
    const r = ps.retrospectiveSignals({ changedFiles: ['a.js', 'extra.js'], diffStat: { added: 1, removed: 0 }, affected: AFF, schema: SCH, declaredPaths: ['a.js'] });
    assert.deepStrictEqual([r.undeclared_files, r.scope_violation], [1, true]);
    assert.ok(!JSON.stringify(r).includes('extra.js'));
});

test('retrospectivo: schema detectado carrega risco; sem detecção risco null', () => {
    const r = ps.retrospectiveSignals({ changedFiles: ['V1__x.sql'], diffStat: { added: 1, removed: 0 }, affected: AFF,
        schema: { detected: true, riskLevel: 'high' }, declaredPaths: ['V1__x.sql'] });
    assert.deepStrictEqual([r.schema_changes_detected, r.schema_risk_level], [true, 'high']);
});

test('retrospectivo: cada fonte ausente vira UNKNOWN (nunca 0/false) e status PARTIAL', () => {
    const r = ps.retrospectiveSignals({ changedFiles: null, diffStat: null, affected: null, schema: null, declaredPaths: U });
    assert.strictEqual(r.status, 'PARTIAL');
    for (const k of ['files_touched', 'files_declared', 'undeclared_files', 'scope_violation', 'affected_services', 'full_suite',
        'schema_changes_detected', 'schema_risk_level', 'diff_lines_added', 'diff_lines_removed', 'risk_level_seen']) {
        assert.strictEqual(r[k], U, k);
    }
});

test('retrospectivo: plano com caminho UNKNOWN impede concluir violação (UNKNOWN)', () => {
    const pro = signalsOf([{ files: tick('a.js') }, { files: null }]);
    assert.strictEqual(ps.declaredUnion(pro), U);
    const r = ps.retrospectiveSignals({ changedFiles: ['a.js'], diffStat: { added: 1, removed: 0 }, affected: AFF, schema: SCH, declaredPaths: ps.declaredUnion(pro) });
    assert.deepStrictEqual([r.scope_violation, r.undeclared_files, r.status], [U, U, 'PARTIAL']);
});

test('globs: ** atravessa diretórios, * não; maiúsculas ignoradas', () => {
    assert.ok(ps.matchesAny('a/b/test/c.js', ['**/test/**']));
    assert.ok(ps.matchesAny('test/c.js', ['**/test/**']));
    assert.ok(!ps.matchesAny('a/b.md', ['*.md']));
    assert.ok(ps.matchesAny('Dockerfile.dev', ['**/Dockerfile*']));
});

// ---- PRI-205 S3b T7: envelope por grupo para o Jev (texto do passo, ACs e caminhos; sem código) ----
test('S3b T7: classifierEnvelopes monta o envelope de cada grupo com os textos do passo, dos ACs e os caminhos', () => {
    const planText = '## Plano de execução\n1. Ajustar listagem\n   - Arquivo: `backend/svc-a/src/a.js`\n   - Critérios: AC-01, AC-02\n   - Verificação: t.\n'
        + '2. Documentar\n   - Arquivo: `README.md`\n   - Critérios: AC-03\n   - Verificação: t.\n';
    const out = ps.classifierEnvelopes(planText, SPEC);
    const keys = [...out.keys()];
    assert.strictEqual(keys.length, 2);
    const first = out.get(keys[0]);
    assert.strictEqual(first.ok, true);
    assert.deepStrictEqual(Object.keys(first.envelope).sort(), ['ac_texts', 'declared_paths', 'step_text']);
    assert.match(first.envelope.step_text, /Ajustar listagem/);
    assert.deepStrictEqual(first.envelope.ac_texts, ['AC-01: lista de transportadoras.', 'AC-02: mensagem de erro.']);
    assert.deepStrictEqual(first.envelope.declared_paths, ['backend/svc-a/src/a.js']);
    assert.deepStrictEqual(out.get(keys[1]).envelope.ac_texts, ['AC-03: ordenação.']);
});

test('S3b T7: passo com bloco de código não vira envelope (R-2: nada de código)', () => {
    const planText = '## Plano de execução\n1. Trocar a função\n   - Arquivo: `a.js`\n   - Critérios: AC-01\n   ```js\n   const x = 1;\n   ```\n';
    const [entry] = [...ps.classifierEnvelopes(planText, SPEC).values()];
    assert.deepStrictEqual(entry, { ok: false, reason: 'STEP_HAS_CODE_BLOCK' });
});

test('S3b T7: AC citado fora da spec fica fora do envelope; plano sem passos devolve vazio', () => {
    const planText = '## Plano de execução\n1. Algo\n   - Arquivo: `a.js`\n   - Critérios: AC-09\n';
    const [entry] = [...ps.classifierEnvelopes(planText, SPEC).values()];
    assert.deepStrictEqual(entry.envelope.ac_texts, []);
    assert.strictEqual(ps.classifierEnvelopes('sem plano', SPEC).size, 0);
});
