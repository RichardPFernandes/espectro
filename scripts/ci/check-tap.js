'use strict';

// PRI-213: the initial list is measured in Actions. Later additions need Richard's
// approval on the PR; this comparator never silently expands the baseline.
const fs = require('node:fs');
const path = require('node:path');

const [evidenceDir, nodeMajor, scriptsExit, dashboardExit] = process.argv.slice(2);
if (!evidenceDir || !['22', '24'].includes(nodeMajor) ||
    ![scriptsExit, dashboardExit].every(value => /^\d+$/.test(value || ''))) {
    console.error('usage: node check-tap.js <evidence-dir> <22|24> <scripts-exit> <dashboard-exit>');
    process.exit(2);
}

function key(suite, node, test) { return JSON.stringify([suite, node, test]); }
function annotation(kind, message) {
    console.log(`::${kind}::${message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`);
}

let known;
try {
    known = JSON.parse(fs.readFileSync(path.join(__dirname, 'known-failures.json'), 'utf8'));
    if (!Array.isArray(known)) throw new Error('expected an array');
    const seen = new Set();
    for (const item of known) {
        if (!item || !['scripts', 'dashboard'].includes(item.suite) ||
            !['22', '24'].includes(item.node) ||
            typeof item.test !== 'string' || !item.test.trim() ||
            typeof item.issue !== 'string' || !item.issue.trim()) {
            throw new Error(`invalid known-failure entry: ${JSON.stringify(item)}`);
        }
        const id = key(item.suite, item.node, item.test);
        if (seen.has(id)) throw new Error(`duplicate known failure: ${id}`);
        seen.add(id);
    }
} catch (error) {
    console.error(`Invalid known-failures.json: ${error.message}`);
    process.exit(2);
}

let errors = 0;
for (const [suite, exit] of [['scripts', Number(scriptsExit)], ['dashboard', Number(dashboardExit)]]) {
    const file = path.join(evidenceDir, `${suite}.tap`);
    let tap;
    try { tap = fs.readFileSync(file, 'utf8'); }
    catch (error) { annotation('error', `${suite}: TAP missing: ${error.message}`); errors++; continue; }
    const failures = new Set();
    const passes = new Set();
    for (const line of tap.split(/\r?\n/)) {
        const match = /^\s*(not ok|ok) \d+ - (.+?)(?: # (?:SKIP|TODO|time=.*))?$/.exec(line);
        if (!match) continue;
        (match[1] === 'not ok' ? failures : passes).add(match[2]);
    }
    const tests = [...tap.matchAll(/^# tests (\d+)$/gm)].at(-1);
    const failed = [...tap.matchAll(/^# fail (\d+)$/gm)].at(-1);
    if (!tests || !failed) { annotation('error', `${suite}: TAP final summary missing`); errors++; continue; }
    if (Number(failed[1]) > 0 && failures.size === 0) {
        annotation('error', `${suite}: ${failed[1]} TAP failures without named not ok entries`); errors++;
    }
    if (exit === 0 && Number(failed[1]) !== 0) {
        annotation('error', `${suite}: exit 0 conflicts with TAP fail=${failed[1]}`); errors++;
    }
    if (exit !== 0 && Number(failed[1]) === 0) {
        annotation('error', `${suite}: command exited ${exit} without TAP test failures`); errors++;
    }
    const suiteKnown = known.filter(item => item.suite === suite && item.node === nodeMajor);
    const knownNames = new Set(suiteKnown.map(item => item.test));
    for (const test of failures) {
        if (!knownNames.has(test)) { annotation('error', `${suite} Node ${nodeMajor}: new failure: ${test}`); errors++; }
    }
    for (const item of suiteKnown) {
        if (failures.has(item.test)) continue;
        if (passes.has(item.test)) annotation('warning', `${suite} Node ${nodeMajor}: ${item.test} passed; remove ${item.issue} from known-failures.json`);
        else { annotation('error', `${suite} Node ${nodeMajor}: listed test absent from TAP: ${item.test}`); errors++; }
    }
    console.log(`${suite} Node ${nodeMajor}: tests=${tests[1]} TAP fail=${failed[1]} exit=${exit}; named failures=${failures.size}; known=${suiteKnown.length}`);
}
process.exitCode = errors ? 1 : 0;
