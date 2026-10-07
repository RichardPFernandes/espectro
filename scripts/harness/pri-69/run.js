#!/usr/bin/env node
// Roda a harness da PRI-69 contra este checkout (a candidata), com artefatos em
// scripts/harness/pri-69/artifacts/<cenário>/.
//
//   node scripts/harness/pri-69/run.js
//   node scripts/harness/pri-69/run.js --target=/caminho/do/checkout
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');

const targetArg = process.argv.find(a => a.startsWith('--target='));
const target = targetArg ? targetArg.slice('--target='.length) : null;
const root = target ? path.resolve(target) : path.resolve(__dirname, '..', '..', '..');
process.env.PRI69_TARGET_ROOT = root;
process.env.PRI69_ARTIFACTS = process.env.PRI69_ARTIFACTS || path.join(__dirname, 'artifacts');

const result = spawnSync(process.execPath, ['--test', path.join(__dirname, 'pri-69.e2e.test.js')], {
    stdio: 'inherit',
    env: process.env,
});
process.exit(result.status == null ? 1 : result.status);
