// node --test scripts/validate-handoff.test.js
// Validação do Agent Handoff Contract (scripts/validate-handoff.js), versões 1.0 e 1.1.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('node:child_process');
const { validate, validateFile, extractYaml, parseArgs, combineExit } = require('./validate-handoff.js');
const { checkPreDone, TASK_TYPES } = require('./lib/maestro-guard-pre-done.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-handoff-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const codes = (r) => r.map((x) => `${x.level}:${x.code}`);
const errors = (r) => r.filter((x) => x.level === 'ERROR').map((x) => x.code);

const v10 = () => ({
    handoff_version: '1.0',
    task: { id: 'PRI-94', objective: 'Provar e2e com stub', specification_ref: 'PRI-94' },
    execution: { agent: 'implementer', status: 'COMPLETED', summary: 'Teste novo', branch: 'feat/x', commit: null },
    artifacts: [{ path: 'scripts/a.test.js', action: 'CREATED', description: 'teste' }],
    decisions: { approved: [], proposed: [] },
    validation: { executed: [{ command: 'node --test scripts/a.test.js', result: 'PASSED', evidence: 'run.log' }], not_executed: [] },
    open_issues: [],
    next: { recommended_agent: 'reviewer', action: 'Revisar', prerequisites: [] },
    context_refs: [],
});
const v11 = () => ({
    ...v10(),
    handoff_version: '1.1',
    task: { ...v10().task, acceptance_criteria: ['AC1', 'AC2'] },
    routing: { from: 'Implementador', to: 'Revisor', runtime: 'claude', fallback_reason: null },
    risk: { level: 'MEDIUM', signals: [], classified_by: 'Coordenador' },
    facts: ['git diff --exit-code HEAD rc=0'],
    assumptions: [],
    usage: { duration: '90s', retries: 0, tokens: 'UNKNOWN' },
});

test('v1.0 completo é válido (compatibilidade)', () => {
    assert.deepStrictEqual(errors(validate(v10())), []);
});

test('v1.1 completo é válido', () => {
    assert.deepStrictEqual(codes(validate(v11())), []);
});

test('o template do repositório é estruturalmente reconhecido, mas reprova por estar vazio', () => {
    const { results } = validateFile(path.join(__dirname, '..', 'templates', 'handoff.yaml.template'));
    const e = errors(results);
    assert.ok(e.includes('TASK_ID_PLACEHOLDER'), e.join());
    assert.ok(e.includes('STATUS'), e.join());
    assert.ok(!e.includes('YAML_PARSE') && !e.includes('NO_YAML'), e.join());
});

test('PASSED sem evidência reprova (regra 7)', () => {
    const d = v10(); d.validation.executed[0].evidence = '';
    assert.ok(errors(validate(d)).includes('PASSED_WITHOUT_EVIDENCE'));
});

test('COMPLETED com falha inesperada e sem open_issues reprova', () => {
    const d = v10(); d.validation.executed[0].result = 'FAILED';
    assert.ok(errors(validate(d)).includes('COMPLETED_WITH_FAILURE'));
});

test('falha inesperada documentada em open_issues vira WARN', () => {
    const d = v10(); d.validation.executed[0].result = 'FAILED'; d.open_issues = ['flake conhecido da PRI-93'];
    const r = validate(d);
    assert.deepStrictEqual(errors(r), []);
    assert.ok(codes(r).includes('WARN:COMPLETED_WITH_KNOWN_FAILURE'));
});

test('injeção de falha com expected: FAILED não conta como falha', () => {
    const d = v10();
    d.validation.executed.push({ command: 'teste contra código sabotado (F1)', result: 'FAILED', expected: 'FAILED', evidence: 'f1.tap' });
    assert.deepStrictEqual(codes(validate(d)), []);
    d.validation.executed[1].result = 'PASSED';
    assert.ok(errors(validate(d)).includes('COMPLETED_WITH_FAILURE'), 'sabotagem que passa é falha inesperada');
});

test('FAILED sem evidência também reprova', () => {
    const d = v10(); d.validation.executed[0] = { command: 'x', result: 'FAILED', evidence: '' }; d.open_issues = ['x'];
    assert.ok(errors(validate(d)).includes('RESULT_WITHOUT_EVIDENCE'));
});

test('NEEDS_HUMAN e BLOCKED exigem open_issues', () => {
    for (const s of ['NEEDS_HUMAN', 'BLOCKED']) {
        const d = v10(); d.execution.status = s;
        assert.ok(errors(validate(d)).includes('BLOCKER_UNDESCRIBED'), s);
        d.open_issues = ['decisão sobre X'];
        assert.ok(!errors(validate(d)).includes('BLOCKER_UNDESCRIBED'), s);
    }
});

test('status e versão fora do enum reprovam', () => {
    const d = v10(); d.execution.status = 'DONE'; d.handoff_version = '2.0';
    const e = errors(validate(d));
    assert.ok(e.includes('STATUS') && e.includes('VERSION'), e.join());
});

test('v1.1 exige routing e risk; HIGH/MAX exigem signals', () => {
    const d = v11(); delete d.routing; delete d.risk;
    assert.ok(errors(validate(d)).includes('ROUTING_MISSING'));
    assert.ok(errors(validate(d)).includes('RISK_MISSING'));
    const h = v11(); h.risk.level = 'HIGH';
    assert.ok(errors(validate(h)).includes('RISK_SIGNALS'));
    h.risk.signals = ['migração de schema'];
    assert.deepStrictEqual(errors(validate(h)), []);
});

test('v1.1: runtime inválido e usage inventado reprovam', () => {
    const d = v11(); d.routing.runtime = 'gpt'; d.usage.tokens = 'uns 20 mil';
    const e = errors(validate(d));
    assert.ok(e.includes('ROUTING_RUNTIME') && e.includes('USAGE_VALUE'), e.join());
});

test('v1.0 não é obrigado a ter campos da 1.1', () => {
    const d = v10();
    assert.ok(!errors(validate(d)).some((c) => c.startsWith('ROUTING') || c.startsWith('RISK')));
});

test('.md em prosa sem bloco yaml é NO_YAML (exit 2)', () => {
    const f = path.join(tmp, 'prosa.md');
    fs.writeFileSync(f, '# Handoff\n\nTudo certo, testes passaram.\n');
    const r = validateFile(f);
    assert.strictEqual(r.code, 2);
    assert.ok(errors(r.results).includes('NO_YAML'));
});

test('.md com bloco yaml é extraído e validado', () => {
    const body = fs.readFileSync(path.join(__dirname, '..', 'templates', 'handoff.yaml.template'), 'utf8')
        .replace('"PRI-XXX"', '"PRI-94"');
    const md = `# Handoff\n\nTexto livre.\n\n\`\`\`yaml\n${body}\`\`\`\n`;
    assert.ok(extractYaml(md, 'x.md').includes('PRI-94'));
});

test('credencial no arquivo reprova sem ecoar o valor', () => {
    const f = path.join(tmp, 'segredo.yaml');
    const fake = 'ATATT' + 'x'.repeat(30);
    fs.writeFileSync(f, `handoff_version: "1.0"\ntask:\n  id: "PRI-1"\n  objective: "o"\n  note: "${fake}"\n`);
    const r = validateFile(f);
    assert.ok(errors(r.results).includes('SECRET'));
    assert.ok(!JSON.stringify(r.results).includes(fake));
});

const homeParent = fs.mkdtempSync(path.join('/workspace', '.pre-done-'));
test.after(() => fs.rmSync(homeParent, { recursive: true, force: true }));
const makeHome = () => fs.mkdtempSync(path.join(homeParent, 'home-'));
const preCodes = (r) => r.results.map((x) => x.code);

function planningPack(home) {
    const evidence = path.join(home, 'Workspace', 'prisma-evidence', '2026-10-14-gov-4');
    fs.mkdirSync(evidence, { recursive: true });
    const handoffFinal = path.join(evidence, 'handoff-final.md');
    fs.writeFileSync(handoffFinal, 'final\n');
    const transfer = path.join(home, 'transfer.yaml');
    fs.writeFileSync(transfer, 'transfer\n');
    const doc = v11();
    doc.closure = {
        task_type: TASK_TYPES.PLANNING,
        approved_document: 'https://linear.app/prisma-app/document/f31-approved',
        evidence,
        handoff_final: handoffFinal,
        planning_ledger: 'https://linear.app/prisma-app/document/planning-ledger',
    };
    return { evidence, handoffFinal, transfer, doc };
}

test('aceitação ignora closure; sem --pre-done o bloco não entra no resultado', () => {
    const d = v11();
    d.closure = { task_type: TASK_TYPES.PLANNING };
    assert.deepStrictEqual(errors(validate(d)), []);
    assert.strictEqual(combineExit(1, 0), 1);
    assert.strictEqual(combineExit(0, 3), 3);
    assert.strictEqual(combineExit(2, 1), 2);
});

test('planejamento Prisma com as quatro citações passa e não registra Done', () => {
    const home = makeHome();
    const { transfer, doc } = planningPack(home);
    const r = checkPreDone(doc, { homeDir: home, handoffPath: transfer, baseDir: home });
    assert.strictEqual(r.exitCode, 0);
    assert.strictEqual(r.outcome, 'evidence_present');
    assert.strictEqual(r.linearDone, 'not_recorded');
    assert.strictEqual(r.humanConfirmation, 'required');
    assert.deepStrictEqual(preCodes(r), ['PRE_DONE_EVIDENCE_PRESENT']);
    assert.ok(r.limits.some((l) => l.includes('Planning Ledger')));
});

test('~/Workspace/... conta como a mesma custódia', () => {
    const home = makeHome();
    const { doc } = planningPack(home);
    doc.closure.evidence = '~/Workspace/prisma-evidence/2026-10-14-gov-4';
    doc.closure.handoff_final = '~/Workspace/prisma-evidence/2026-10-14-gov-4/handoff-final.md';
    const r = checkPreDone(doc, { homeDir: home, baseDir: home });
    assert.strictEqual(r.exitCode, 0, preCodes(r).join());
});

test('caminho canônico da Evidence é aceito quando o diretório home é um symlink', () => {
    const realHome = makeHome();
    const pack = planningPack(realHome);
    const linkHome = path.join(homeParent, `home-link-${process.pid}-${Date.now()}`);
    fs.symlinkSync(realHome, linkHome);
    try {
        pack.doc.closure.evidence = fs.realpathSync(pack.evidence);
        pack.doc.closure.handoff_final = fs.realpathSync(pack.handoffFinal);
        const accepted = checkPreDone(pack.doc, { homeDir: linkHome, baseDir: linkHome, handoffPath: pack.transfer });
        assert.strictEqual(accepted.exitCode, 0, preCodes(accepted).join(' '));
        assert.strictEqual(accepted.outcome, 'evidence_present');

        const outside = planningPack(realHome).doc;
        outside.closure.evidence = fs.realpathSync(path.join(realHome, 'Workspace'));
        const refused = checkPreDone(outside, { homeDir: linkHome, baseDir: linkHome });
        assert.ok(preCodes(refused).includes('PRE_DONE_EVIDENCE_CUSTODY'), preCodes(refused).join(' '));
    } finally {
        fs.unlinkSync(linkHome);
    }
});

test('planejamento Prisma recusa citação ausente, UNKNOWN, /tmp, /private/tmp e data inválida', () => {
    const home = makeHome();
    const missing = v11();
    missing.closure = { task_type: TASK_TYPES.PLANNING };
    const missingResult = checkPreDone(missing, { homeDir: home });
    assert.strictEqual(missingResult.exitCode, 1);
    assert.strictEqual(preCodes(missingResult).filter((c) => c === 'PRE_DONE_MISSING').length, 4);

    const unknown = planningPack(home).doc;
    unknown.closure.planning_ledger = 'UNKNOWN';
    assert.ok(preCodes(checkPreDone(unknown, { homeDir: home })).includes('PRE_DONE_UNKNOWN'));

    const ephemeral = planningPack(home).doc;
    ephemeral.closure.evidence = '/tmp/prisma-evidence/2026-10-14-gov-4';
    assert.ok(preCodes(checkPreDone(ephemeral, { homeDir: home })).includes('PRE_DONE_EPHEMERAL'));

    const privateTmp = planningPack(home).doc;
    privateTmp.closure.handoff_final = '/private/tmp/gov-3/handoff.md';
    assert.ok(preCodes(checkPreDone(privateTmp, { homeDir: home })).includes('PRE_DONE_EPHEMERAL'));

    const badDate = planningPack(home).doc;
    const bogus = path.join(home, 'Workspace', 'prisma-evidence', '2026-13-40-gov-4');
    fs.mkdirSync(bogus, { recursive: true });
    badDate.closure.evidence = bogus;
    assert.ok(preCodes(checkPreDone(badDate, { homeDir: home })).includes('PRE_DONE_EVIDENCE_CUSTODY'));
});

test('Evidence em URL e diretório ausente são recusados', () => {
    const home = makeHome();
    const asUrl = planningPack(home).doc;
    asUrl.closure.evidence = 'https://linear.app/prisma-app/document/evidence';
    assert.ok(preCodes(checkPreDone(asUrl, { homeDir: home })).includes('PRE_DONE_EVIDENCE_CUSTODY'));

    const absent = planningPack(home).doc;
    absent.closure.evidence = path.join(home, 'Workspace', 'prisma-evidence', '2026-10-14-ausente');
    assert.ok(preCodes(checkPreDone(absent, { homeDir: home })).includes('PRE_DONE_NOT_FOUND'));
});

test('handoff temporário e arquivo fora da Evidence não substituem o Handoff FINAL', () => {
    const home = makeHome();
    const pack = planningPack(home);
    pack.doc.closure.handoff_final = pack.transfer;
    const swapped = checkPreDone(pack.doc, { homeDir: home, handoffPath: pack.transfer, baseDir: home });
    assert.ok(preCodes(swapped).includes('PRE_DONE_TEMP_HANDOFF'), preCodes(swapped).join());
    assert.ok(!preCodes(swapped).includes('PRE_DONE_OUTSIDE_CUSTODY'));

    const outside = path.join(home, 'notes.md');
    fs.writeFileSync(outside, 'nota\n');
    const pack2 = planningPack(home);
    pack2.doc.closure.handoff_final = outside;
    const out = checkPreDone(pack2.doc, { homeDir: home, handoffPath: pack2.transfer, baseDir: home });
    assert.ok(preCodes(out).includes('PRE_DONE_OUTSIDE_CUSTODY'), preCodes(out).join());
});

test('symlink para /tmp não conta como arquivo persistido', () => {
    const home = makeHome();
    const pack = planningPack(home);
    const target = path.join(os.tmpdir(), `pre-done-link-${process.pid}-${Date.now()}.md`);
    fs.writeFileSync(target, 'alvo\n');
    try {
        fs.rmSync(pack.handoffFinal);
        fs.symlinkSync(target, pack.handoffFinal);
        const r = checkPreDone(pack.doc, { homeDir: home, handoffPath: pack.transfer, baseDir: home });
        assert.ok(preCodes(r).includes('PRE_DONE_EPHEMERAL'), preCodes(r).join());
    } finally {
        fs.rmSync(target, { force: true });
    }
});

test('outros tipos e tipo ausente ficam com o Richard, sem exigir as quatro citações', () => {
    for (const taskType of [TASK_TYPES.DOCUMENTAL, TASK_TYPES.IMPLEMENTATION, TASK_TYPES.BUG, TASK_TYPES.DISCOVERY, TASK_TYPES.REVIEW]) {
        const d = v11();
        d.closure = { task_type: taskType };
        const r = checkPreDone(d, { homeDir: makeHome() });
        assert.strictEqual(r.exitCode, 3, taskType);
        assert.strictEqual(r.outcome, 'human');
        assert.strictEqual(r.linearDone, 'not_recorded');
        assert.deepStrictEqual(preCodes(r), ['PRE_DONE_CRITERIA_UNDEFINED']);
    }
    const absent = checkPreDone(v11(), { homeDir: makeHome() });
    assert.strictEqual(absent.exitCode, 3);
    assert.deepStrictEqual(preCodes(absent), ['PRE_DONE_TYPE_ABSENT']);
    const unknown = checkPreDone(v11(), { homeDir: makeHome(), taskType: 'planejamento-prisma' });
    assert.strictEqual(unknown.exitCode, 3);
    assert.deepStrictEqual(preCodes(unknown), ['PRE_DONE_TYPE_UNKNOWN']);
});

test('task_type divergente é recusado sem escolher um lado', () => {
    const home = makeHome();
    const { doc } = planningPack(home);
    const r = checkPreDone(doc, { homeDir: home, taskType: TASK_TYPES.BUG });
    assert.strictEqual(r.exitCode, 1);
    assert.deepStrictEqual(preCodes(r), ['PRE_DONE_TYPE_CONFLICT']);
    assert.strictEqual(r.linearDone, 'not_recorded');
});

test('URL que não é https://linear.app/ é recusada no planejamento Prisma', () => {
    const home = makeHome();
    const { doc } = planningPack(home);
    doc.closure.approved_document = 'http://linear.app/prisma-app/document/f31';
    assert.ok(preCodes(checkPreDone(doc, { homeDir: home })).includes('PRE_DONE_INVALID'));
});

test('a checagem não chama a rede nem grava issue', () => {
    const src = fs.readFileSync(path.join(__dirname, 'lib', 'maestro-guard-pre-done.js'), 'utf8');
    assert.ok(!/\bfetch\s*\(/.test(src));
    assert.ok(!/require\(['"]https?['"]\)/.test(src));
    assert.ok(!/save_issue|graphql/.test(src));
});

test('parseArgs não trata o valor de --task-type como arquivo', () => {
    const parsed = parseArgs(['--pre-done', '--task-type', TASK_TYPES.BUG, 'handoff.yaml', '--base', path.join(tmp, 'base')]);
    assert.strictEqual(parsed.preDone, true);
    assert.strictEqual(parsed.taskType, TASK_TYPES.BUG);
    assert.deepStrictEqual(parsed.files, ['handoff.yaml']);
    assert.strictEqual(parsed.missingFlagValue, false);
    assert.strictEqual(parseArgs(['a.yaml', '--task-type']).missingFlagValue, true);
});

function writeHandoff(file, closureLines) {
    const body = [
        'handoff_version: "1.0"',
        'task:',
        '  id: "PRI-138"',
        '  objective: "Checagem pré-Done"',
        '  specification_ref: "PRI-138"',
        'execution:',
        '  agent: "implementer"',
        '  status: "COMPLETED"',
        '  summary: "Citações conferidas"',
        '  branch: "cursor/gov-4-pre-done-2c82-c149"',
        '  commit: null',
        'artifacts: []',
        'decisions:',
        '  approved: []',
        '  proposed: []',
        'validation:',
        '  executed:',
        '    - command: "node --test scripts/validate-handoff.test.js"',
        '      result: "PASSED"',
        '      evidence: "tap"',
        '  not_executed: []',
        'open_issues: []',
        'next:',
        '  recommended_agent: "reviewer"',
        '  action: "Revisar"',
        '  prerequisites: []',
        'context_refs: []',
        closureLines,
    ].join('\n');
    fs.writeFileSync(file, `${body}\n`);
}

test('CLI --pre-done em tipo sem critério sai 3 e declara que Done não foi registrado', () => {
    const f = path.join(tmp, 'bug.yaml');
    writeHandoff(f, 'closure:\n  task_type: "Correção de bug"');
    const ran = spawnSync(process.execPath, [path.join(__dirname, 'validate-handoff.js'), f, '--pre-done'], { encoding: 'utf8' });
    assert.strictEqual(ran.status, 3, ran.stdout + ran.stderr);
    assert.match(ran.stdout, /PRE_DONE_CRITERIA_UNDEFINED/);
    assert.match(ran.stdout, /Done no Linear: não registrado/);
    assert.match(ran.stdout, /confirmação do Richard: obrigatória/);
});

function evidenceDirsCreatedBy(leaf) {
    const created = [];
    let cursor = path.resolve(leaf);
    while (!fs.existsSync(cursor)) {
        created.push(cursor);
        const parent = path.dirname(cursor);
        if (parent === cursor) break;
        cursor = parent;
    }
    return created;
}

function removeEvidenceDirs(created, leaf) {
    const leafResolved = path.resolve(leaf);
    const owned = new Set(created.map((dir) => path.resolve(dir)));
    if (owned.has(leafResolved)) fs.rmSync(leafResolved, { recursive: true, force: true });
    const parents = [...owned]
        .filter((dir) => dir !== leafResolved)
        .sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
    for (const dir of parents) {
        if (!fs.existsSync(dir)) continue;
        const st = fs.lstatSync(dir);
        if (!st.isDirectory() || st.isSymbolicLink()) continue;
        if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    }
}

test('a limpeza do CLI pré-Done remove só diretórios que o teste criou', () => {
    const root = fs.mkdtempSync(path.join(homeParent, 'custody-preexist-'));
    const workspace = path.join(root, 'Workspace');
    const custody = path.join(workspace, 'prisma-evidence');
    fs.mkdirSync(custody, { recursive: true });
    const leaf = path.join(custody, `2026-10-14-gov4cli${process.pid}`);
    const created = evidenceDirsCreatedBy(leaf);
    fs.mkdirSync(leaf, { recursive: true });
    fs.writeFileSync(path.join(leaf, 'handoff-final.md'), 'final\n');
    removeEvidenceDirs(created, leaf);
    assert.strictEqual(fs.existsSync(leaf), false);
    assert.strictEqual(fs.existsSync(custody), true);
    assert.strictEqual(fs.existsSync(workspace), true);
    assert.deepStrictEqual(fs.readdirSync(custody), []);

    const onlyWorkspace = fs.mkdtempSync(path.join(homeParent, 'custody-workspace-'));
    const workspaceOnly = path.join(onlyWorkspace, 'Workspace');
    fs.mkdirSync(workspaceOnly);
    const createdLeaf = path.join(workspaceOnly, 'prisma-evidence', `2026-10-14-gov4cli${process.pid}`);
    const createdParents = evidenceDirsCreatedBy(createdLeaf);
    fs.mkdirSync(createdLeaf, { recursive: true });
    removeEvidenceDirs(createdParents, createdLeaf);
    assert.strictEqual(fs.existsSync(createdLeaf), false);
    assert.strictEqual(fs.existsSync(path.join(workspaceOnly, 'prisma-evidence')), false);
    assert.strictEqual(fs.existsSync(workspaceOnly), true);

    const fresh = fs.mkdtempSync(path.join(homeParent, 'custody-fresh-'));
    const freshLeaf = path.join(fresh, 'Workspace', 'prisma-evidence', `2026-10-14-gov4cli${process.pid}`);
    const freshCreated = evidenceDirsCreatedBy(freshLeaf);
    fs.mkdirSync(freshLeaf, { recursive: true });
    fs.writeFileSync(path.join(freshLeaf, 'handoff-final.md'), 'final\n');
    removeEvidenceDirs(freshCreated, freshLeaf);
    assert.strictEqual(fs.existsSync(path.join(fresh, 'Workspace')), false);
    assert.strictEqual(fs.existsSync(fresh), true);
});

test('CLI do planejamento Prisma aceita a custódia em ~/Workspace e recusa citação faltante', () => {
    const leaf = path.join(os.homedir(), 'Workspace', 'prisma-evidence', `2026-10-14-gov4cli${process.pid}`);
    const finalPath = path.join(leaf, 'handoff-final.md');
    const f = path.join(tmp, 'plan.yaml');
    const created = evidenceDirsCreatedBy(leaf);
    try {
        fs.mkdirSync(leaf, { recursive: true });
        fs.writeFileSync(finalPath, 'final\n');
        writeHandoff(f, [
            'closure:',
            `  task_type: "${TASK_TYPES.PLANNING}"`,
            '  approved_document: "https://linear.app/prisma-app/document/f31-approved"',
            '  evidence: "~/Workspace/prisma-evidence/' + path.basename(leaf) + '"',
            '  handoff_final: "~/Workspace/prisma-evidence/' + path.basename(leaf) + '/handoff-final.md"',
            '  planning_ledger: "https://linear.app/prisma-app/document/planning-ledger"',
        ].join('\n'));
        const ok = spawnSync(process.execPath, [path.join(__dirname, 'validate-handoff.js'), f, '--pre-done'], { encoding: 'utf8' });
        assert.strictEqual(ok.status, 0, ok.stdout + ok.stderr);
        assert.match(ok.stdout, /PRE_DONE_EVIDENCE_PRESENT/);
        assert.match(ok.stdout, /Done no Linear: não registrado/);

        writeHandoff(f, `closure:\n  task_type: "${TASK_TYPES.PLANNING}"`);
        const refused = spawnSync(process.execPath, [path.join(__dirname, 'validate-handoff.js'), f, '--pre-done'], { encoding: 'utf8' });
        assert.strictEqual(refused.status, 1, refused.stdout + refused.stderr);
        assert.match(refused.stdout, /PRE_DONE_MISSING/);
        assert.match(refused.stdout, /Done no Linear: não registrado/);
    } finally {
        removeEvidenceDirs(created, leaf);
    }
});

test('--check-paths acusa artefato e evidência inexistentes', () => {
    const d = v10();
    const e = errors(validate(d, { checkPaths: true, baseDir: tmp }));
    assert.ok(e.includes('ARTIFACT_NOT_FOUND') && e.includes('EVIDENCE_NOT_FOUND'), e.join());
    fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'scripts', 'a.test.js'), '');
    fs.writeFileSync(path.join(tmp, 'run.log'), 'ok');
    assert.deepStrictEqual(errors(validate(d, { checkPaths: true, baseDir: tmp })), []);
});
