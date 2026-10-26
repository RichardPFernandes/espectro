'use strict';
// Utilitário exclusivo das fixtures C0. Nunca lê o HOME/config do operador.
const fs = require('node:fs');
const path = require('node:path');
const corpus = require('./adversarial.json');

function materialize(root) {
    for (const item of corpus.sentinels) {
        const file = path.join(root, item.path);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        let content = `${item.marker}\n`;
        if (item.kind === 'dotenv') content = `SYNTHETIC_SENTINEL=${item.marker}\n`;
        if (item.kind === 'other_state') content = JSON.stringify({ task_id: '990999-other', note: item.marker });
        if (item.kind === 'large') content = content.padEnd(corpus.large_file_bytes, 'x');
        fs.writeFileSync(file, content);
    }
    const link = path.join(root, corpus.symlink.path);
    fs.symlinkSync(corpus.symlink.target, link);
    return corpus;
}

module.exports = { materialize };
