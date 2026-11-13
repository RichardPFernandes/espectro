'use strict';
// PRI-181 c2b-2-protocol (SPEC-c2b-2-protocol r5.1): AC-13 com WATCHER_QA_DIAGNOSTICO ausente.
// O protocolo nunca é chamado (spy) e nenhum byte do run muda. Processo próprio (constante de carga).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pri181-c2b2-flag-off-'));
const repo = path.join(tmp, 'consumer');
fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
fs.copyFileSync(path.resolve(__dirname, '../../.claude/spec-hash-config.json'), path.join(repo, '.claude/spec-hash-config.json'));
const envKeys = ['REPO_PATH', 'REDMINE_URL', 'REDMINE_API_KEY', 'WATCHER_QA_DIAGNOSTICO'];
const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
Object.assign(process.env, { REPO_PATH: repo, REDMINE_URL: 'https://redmine.synthetic.invalid', REDMINE_API_KEY: 'synthetic-key-c2b2' });
delete process.env.WATCHER_QA_DIAGNOSTICO;

const protocol = require('./qa-diagnosis-protocol');
const model = require('./qa-diagnosis-model');
const touched = [];
for (const [name, fn] of Object.entries(protocol)) {
    if (typeof fn !== 'function') continue;
    protocol[name] = function spy(...args) { touched.push(name); return fn.apply(this, args); };
}
const watcher = require('../readmine-watcher');

test.after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const key of envKeys) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
    }
});

test('modo: flag ausente = desligada neste processo', () => {
    assert.equal(watcher.QA_DIAGNOSTICO, false);
});

test('AC-13: flag ausente → o passo não chama o protocolo e nenhum byte muda', () => {
    const dir = path.join(repo, 'memory/runs/4242-a');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
        task_id: '4242-a', node: 'implement', status: 'blocked', history: [], events: [],
        qa_rejections: [{ rejection_key: 'redmine:4242:j101', diagnosis: model.initialDiagnosisBlock() }],
    }));
    const before = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
    touched.length = 0;
    assert.equal(watcher.qaDiagnosisTickSafe(), null);
    assert.deepEqual(touched, []);
    assert.equal(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'), before);
    assert.ok(!fs.existsSync(path.join(repo, 'memory/runs', protocol.STAGING_DIR)));
});
