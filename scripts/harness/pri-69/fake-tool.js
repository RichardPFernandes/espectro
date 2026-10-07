// `mvn` e `java` falsos (instalados no bin da sandbox). mvn grava o pid, sobe um `java`
// filho e repassa SIGTERM para ele, como o wrapper do Maven faz com a JVM do surefire;
// java grava o pid e fica vivo "rodando teste" até receber sinal ou passar
// HARNESS_TOOL_MS (padrão 120 s — de propósito maior que qualquer teste: se sobrar
// vivo, a checagem de órfão pega).
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const tool = path.basename(process.argv[1]);
const pidsDir = process.env.HARNESS_PIDS;
const lifetime = Number(process.env.HARNESS_TOOL_MS) || 120000;

function record(event, extra = {}) {
    if (!pidsDir) return;
    fs.mkdirSync(pidsDir, { recursive: true });
    fs.appendFileSync(path.join(pidsDir, 'tools.jsonl'), JSON.stringify({ at: new Date().toISOString(), tool, event, pid: process.pid, ppid: process.ppid, ...extra }) + '\n');
}

record('start', { args: process.argv.slice(2) });
const keepAlive = setTimeout(() => { record('timeout_exit'); process.exit(0); }, lifetime);

let child = null;
if (tool === 'mvn') {
    child = spawn('java', ['-jar', 'surefire-booter.jar', ...process.argv.slice(2)], { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('exit', (code, signal) => {
        record('child_exit', { child: 'java', code, signal });
        clearTimeout(keepAlive);
        process.exit(signal ? 143 : code ?? 0);
    });
    process.stdout.write(`[INFO] Scanning for projects... (fake mvn pid ${process.pid})\n`);
} else {
    process.stdout.write(`[fake java pid ${process.pid}] Running br.com.mosistemas.FakeTest\n`);
}

process.on('SIGTERM', () => {
    record('sigterm');
    if (child && child.exitCode === null) child.kill('SIGTERM');
    else { clearTimeout(keepAlive); process.exit(143); }
});
