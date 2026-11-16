'use strict';
// Lê o TAP gravado pela receita e lista os testes que falharam (nome e arquivo)
// no log do job e no $GITHUB_STEP_SUMMARY. Só relata: não muda o exit da suíte.
const fs = require('node:fs');
const path = require('node:path');

const unquote = v => v.replace(/^(['"])(.*)\1$/, '$2');

function parseFailures(tap, root = process.cwd()) {
    const lines = tap.split(/\r?\n/);
    const failures = [];
    for (let i = 0; i < lines.length; i += 1) {
        const m = /^(\s*)not ok \d+ - (.*)$/.exec(lines[i]);
        if (!m || /\s# (TODO|SKIP)\b/i.test(m[2])) continue;
        const pad = `${m[1]}  `;
        const info = {};
        if (lines[i + 1] === `${pad}---`) {
            for (let j = i + 2; j < lines.length && lines[j] !== `${pad}...`; j += 1) {
                const kv = /^(\w+): ?(.*)$/.exec(lines[j].slice(pad.length));
                if (!kv || !lines[j].startsWith(pad) || kv[1] in info) continue;
                // `error: |-` abre bloco: vale a primeira linha não vazia dele.
                info[kv[1]] = /^[|>]/.test(kv[2]) ? (lines.slice(j + 1).find(l => l.trim()) || '').trim() : unquote(kv[2]);
            }
        }
        if (info.failureType === 'subtestsFailed') continue; // o filho que falhou já entra na lista
        const loc = /^(.*?):(\d+):\d+$/.exec(info.location || '');
        // Arquivo que cai fora de um teste (ao carregar) vem com o próprio caminho como nome.
        const raw = m[2].replace(/\\#/g, '#');
        const name = path.isAbsolute(raw) ? path.relative(root, raw) : raw;
        const file = loc ? path.relative(root, loc[1]) : (path.isAbsolute(raw) ? name : 'arquivo desconhecido');
        failures.push({ name, file, line: loc ? Number(loc[2]) : null, error: info.error || '' });
    }
    return failures;
}

function report(tapFiles, { root = process.cwd(), env = process.env, out = console.log } = {}) {
    const md = ['### Testes que falharam', ''];
    for (const tapFile of tapFiles) {
        const suite = path.basename(tapFile, '.tap');
        let tap;
        try { tap = fs.readFileSync(tapFile, 'utf8'); } catch (err) {
            out(`[${suite}] TAP ilegível: ${err.message}`);
            md.push(`- **${suite}**: TAP ilegível`);
            continue;
        }
        const failures = parseFailures(tap, root);
        if (!failures.length) {
            if (/^# fail 0$/m.test(tap) && /^# cancelled 0$/m.test(tap)) { out(`[${suite}] sem falha no TAP`); continue; }
            // Sem `not ok` e sem resumo limpo: a suíte nem terminou (harness, timeout, sinal).
            const tail = tap.trimEnd().split(/\r?\n/).slice(-15);
            out(`[${suite}] suíte falhou sem "not ok" no TAP; últimas linhas:\n${tail.join('\n')}`);
            md.push(`- **${suite}**: falhou sem \`not ok\` no TAP`, '', '```text', ...tail, '```');
            continue;
        }
        out(`[${suite}] ${failures.length} teste(s) falharam:`);
        for (const f of failures) {
            const where = f.line ? `${f.file}:${f.line}` : f.file;
            out(`  not ok — ${where} — ${f.name}${f.error ? `\n      ${f.error}` : ''}`);
            if (env.GITHUB_ACTIONS && f.line) {
                const esc = s => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
                out(`::error file=${esc(f.file).replace(/,/g, '%2C')},line=${f.line}::${esc(f.name)}`);
            }
            md.push(`- **${suite}** \`${where}\` — ${f.name.replace(/[|<>`]/g, ' ')}`);
        }
    }
    if (env.GITHUB_STEP_SUMMARY && md.length > 2) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${md.join('\n')}\n`);
}

module.exports = { parseFailures, report };
if (require.main === module) report(process.argv.slice(2));
