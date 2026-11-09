// Reprodutibilidade do Jev (U15) — PRI-205 S3b, SPEC §B9, AC-13.
//
// A mesma entrada vai N vezes ao Jev (N = 5 por padrão), e mede-se quantas entradas
// devolvem o mesmo enum em todas as N. Limiar do §4.8: ≥ 95% das entradas.
//
// - Entradas: os envelopes que o classifier-shadow gravou em
//   `<run>/dom06/classifier/envelopes/<sha256>.json` (Q6), ou um envelope sintético
//   embutido (--synthetic, teste de fumaça P-3). O hash do conteúdo tem de bater com o
//   nome; senão a entrada é pulada e contada.
// - Cada repetição é um Attempt de efeito próprio no diretório de saída, com
//   `rep_index` na EffectId (R-4). COMPLETE não se refaz; FAILED/UNCERTAIN nunca se
//   repetem e contam como faltantes.
// - `maxCalls` é obrigatório (saldo de USD 9, limite físico da conta).
// - Dado faltante é UNKNOWN: uma entrada incompleta não tem concordância, e o
//   veredito com qualquer entrada incompleta é UNKNOWN, nunca PASS.
// - O relatório só tem hashes, contagens e classes. Nunca texto de envelope ou chave.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const shadow = require('./classifier-shadow');
const classifierGuard = require('./classifier-guard');
const jevClient = require('./jev-client');

const THRESHOLD = 0.95;
const DEFAULT_N = 5;
const MIN_N = 2;
const MAX_N = 20;
const CLASSES = ['C1', 'C2', 'C3', 'C4', 'C5'];

const SYNTHETIC_ENVELOPE = Object.freeze({
    step_text: 'Ajustar a função de formatação de datas em src/util/format-date.js para aceitar o fuso informado.',
    ac_texts: Object.freeze(['AC-01: a data aparece no fuso informado pelo usuário.']),
    declared_paths: Object.freeze(['src/util/format-date.js', 'test/util/format-date.test.js']),
});

function sha256(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}

function plainEnvelope(e) {
    return { step_text: e.step_text, ac_texts: [...e.ac_texts], declared_paths: [...e.declared_paths] };
}

// Envelopes gravados sob runsDir (qualquer profundidade), sem entrar em outDir.
function discoverEnvelopes(runsDir, outDir) {
    const found = new Map();
    let skipped = 0;
    const skipRoot = outDir ? path.resolve(outDir) : null;
    const walk = dir => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const p = path.join(dir, e.name);
            if (e.isSymbolicLink()) continue;
            if (e.isDirectory()) {
                if (skipRoot && path.resolve(p) === skipRoot) continue;
                walk(p);
                continue;
            }
            if (!e.isFile() || !/^[0-9a-f]{64}\.json$/.test(e.name)) continue;
            if (!dir.endsWith(path.join('dom06', 'classifier', 'envelopes'))) continue;
            try {
                const env = JSON.parse(fs.readFileSync(p, 'utf8'));
                const sha = sha256(shadow.canonical(env));
                if (`${sha}.json` !== e.name) { skipped += 1; continue; }
                found.set(sha, env);
            } catch {
                skipped += 1;
            }
        }
    };
    walk(runsDir);
    return { envelopes: [...found.entries()].sort(([a], [b]) => a.localeCompare(b)), skipped };
}

function summarizeEntry(sha, values, n) {
    const answers = {};
    for (const v of values) answers[v] = (answers[v] || 0) + 1;
    let mode = null;
    for (const [k, c] of Object.entries(answers)) {
        const better = !mode || c > answers[mode]
            || (c === answers[mode] && CLASSES.indexOf(k) !== -1 && (CLASSES.indexOf(mode) === -1 || CLASSES.indexOf(k) < CLASSES.indexOf(mode)));
        if (better) mode = k;
    }
    const complete = values.length === n;
    return {
        envelope: sha.slice(0, 12),
        answered: values.length,
        missing: n - values.length,
        answers,
        mode_class: mode,
        agreement: complete ? answers[mode] / n : 'UNKNOWN',
        all_equal: complete ? answers[mode] === n : 'UNKNOWN',
    };
}

/**
 * @param {{ runsDir?: string, outDir?: string, n?: number, maxCalls: number, effective: object,
 *   synthetic?: boolean, client?: { classify: Function }, credentialProvider?: Function, guard?: object }} input
 * @returns {Promise<{ status: 'OK'|'OFF'|'USAGE', reason: string|null, report: object|null }>}
 */
async function calibrate({
    runsDir, outDir, n = DEFAULT_N, maxCalls, effective, synthetic = false,
    client = jevClient, credentialProvider = jevClient.readKeychainCredential, guard = classifierGuard,
} = {}) {
    const usage = reason => ({ status: 'USAGE', reason, report: null });
    if (!Number.isInteger(maxCalls) || maxCalls < 1) return usage('MAX_CALLS_REQUIRED');
    if (!Number.isInteger(n) || n < MIN_N || n > MAX_N) return usage('N_OUT_OF_RANGE');
    if (!synthetic && !runsDir) return usage('RUNS_DIR_REQUIRED');
    if (synthetic && !outDir) return usage('OUT_DIR_REQUIRED');
    if (!effective || effective.provider !== 'jev') return { status: 'OFF', reason: (effective && effective.reason) || 'NOT_JEV', report: null };

    const out = path.resolve(outDir || path.join(runsDir, '_jev-u15'));
    fs.mkdirSync(out, { recursive: true });
    // Uma execução por diretório de saída (achado MINOR 4 da revisão): duas execuções
    // simultâneas no mesmo --out enviariam em dobro. A não repetição entre execuções
    // depende de usar SEMPRE o mesmo --out (documentado).
    const lockPath = path.join(out, '.calibration.lock');
    try {
        fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
    } catch (e) {
        if (e && e.code === 'EEXIST') return { status: 'BUSY', reason: 'CALIBRATION_IN_PROGRESS', report: null };
        throw e;
    }
    try {
        return await runCalibration({ runsDir, out, n, maxCalls, effective, synthetic, client, credentialProvider, guard });
    } finally {
        try { fs.unlinkSync(lockPath); } catch { /* já removida */ }
    }
}

async function runCalibration({ runsDir, out, n, maxCalls, effective, synthetic, client, credentialProvider, guard }) {
    const discovered = synthetic
        ? { envelopes: [[sha256(shadow.canonical(plainEnvelope(SYNTHETIC_ENVELOPE))), plainEnvelope(SYNTHETIC_ENVELOPE)]], skipped: 0 }
        : discoverEnvelopes(runsDir, out);

    const promptSha = jevClient.promptSha256();
    let callsMade = 0;
    let credential = null;
    let credentialFailed = false;
    let stopped = null;
    let skippedGuard = 0;
    const entries = [];

    for (const [sha, envelope] of discovered.envelopes) {
        if (!guard.checkEnvelope(envelope).ok) { skippedGuard += 1; continue; }
        const values = [];
        for (let rep = 1; rep <= n; rep += 1) {
            const effectId = sha256(shadow.canonical(['U15', sha, promptSha, effective.model_id, rep]));
            const prior = shadow.priorOutcome(out, effectId);
            if (prior.found) {
                if (prior.answer) values.push(prior.answer.parse === 'OK' ? prior.answer.class : 'OUT_OF_ENUM');
                continue;
            }
            if (stopped || credentialFailed || callsMade >= maxCalls) continue;
            if (!credential) {
                const c = await credentialProvider(effective.credential);
                if (!c || !c.ok) { credentialFailed = true; continue; }
                credential = c;
            }
            callsMade += 1;
            const emitted = await shadow.emitOnce({
                runDir: out, effectId, envelope, effective, credential: credential.value, client,
                snapshotFields: {
                    purpose: 'U15', envelope_sha256: sha, rep_index: rep, prompt_sha256: promptSha, model_id: effective.model_id,
                    authority_ref: effective.authority_ref ? { id: effective.authority_ref.id, sha256: effective.authority_ref.sha256 } : null,
                },
            });
            if (emitted.status === 'OK') values.push(emitted.compact.class);
            else if (emitted.status === 'OUT_OF_ENUM') values.push('OUT_OF_ENUM');
            if (emitted.authRejected) stopped = 'JEV_AUTH_REJECTED';
        }
        entries.push(summarizeEntry(sha, values, n));
    }

    const complete = entries.filter(e => e.missing === 0);
    const allEqual = complete.filter(e => e.all_equal === true).length;
    const incomplete = entries.length - complete.length;
    const rate = entries.length && !incomplete ? allEqual / entries.length : 'UNKNOWN';
    let verdict = 'UNKNOWN';
    if (rate !== 'UNKNOWN') verdict = rate >= THRESHOLD ? 'PASS' : 'FAIL';

    return {
        status: 'OK',
        reason: stopped || (credentialFailed ? 'CREDENTIAL_UNAVAILABLE' : null),
        report: {
            n,
            max_calls: maxCalls,
            calls_made: callsMade,
            out_dir: out,
            prompt_sha256: promptSha,
            model_id: effective.model_id,
            skipped_invalid: discovered.skipped,
            skipped_guard: skippedGuard,
            envelopes: entries,
            summary: {
                envelopes: entries.length,
                complete: complete.length,
                all_equal_count: allEqual,
                rate,
                threshold: THRESHOLD,
                verdict,
            },
        },
    };
}

module.exports = { calibrate, SYNTHETIC_ENVELOPE, THRESHOLD, DEFAULT_N };
