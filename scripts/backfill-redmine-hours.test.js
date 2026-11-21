'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseArgs } = require('./backfill-redmine-hours');

test('AC-4 parseArgs recusa --max-entry-hours que não é número maior que zero', () => {
    for (const valor of ['0', '-1', 'abc', '']) {
        assert.throws(
            () => parseArgs([`--max-entry-hours=${valor}`]),
            /--max-entry-hours exige número > 0/,
            `valor ${JSON.stringify(valor)} deveria ser recusado`,
        );
    }
});

test('AC-4 parseArgs sem --max-entry-hours deixa o teto desligado (null)', () => {
    assert.strictEqual(parseArgs([]).maxEntryHours, null);
});

test('AC-4 parseArgs aceita --max-entry-hours nas duas formas, sem arredondar', () => {
    assert.strictEqual(parseArgs(['--max-entry-hours=8']).maxEntryHours, 8);
    assert.strictEqual(parseArgs(['--max-entry-hours', '7.5']).maxEntryHours, 7.5);
});
