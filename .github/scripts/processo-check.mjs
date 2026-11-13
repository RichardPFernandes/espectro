#!/usr/bin/env node
// processo-check: barreira do Acordo de desenvolvimento v2 (seção 8).
// Lê o evento pull_request (GITHUB_EVENT_PATH) e a lista de arquivos do PR
// (API do GitHub, só leitura) e aplica as regras de .github/processo.json.
//
// Uso local, sem rede:
//   node .github/scripts/processo-check.mjs --event payload.json --files files.json
// files.json = array no formato de GET /repos/{o}/{r}/pulls/{n}/files.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, loadConfig } from './processo-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(HERE, '..', 'pull_request_template.md');

function arg(name) {
    const i = process.argv.indexOf(name);
    return i === -1 ? undefined : process.argv[i + 1];
}

async function gh(url, token) {
    const res = await fetch(`https://api.github.com${url}`, {
        headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${token}`,
            'x-github-api-version': '2022-11-28',
        },
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status} em ${url}`);
    return res.json();
}

async function fetchFiles(repo, number, token) {
    const files = [];
    for (let page = 1; ; page++) {
        const batch = await gh(`/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`, token);
        files.push(...batch);
        if (batch.length < 100) return files;
    }
}

async function main() {
    const eventPath = arg('--event') ?? process.env.GITHUB_EVENT_PATH;
    if (!eventPath) throw new Error('sem evento: passe --event <payload.json> ou rode no GitHub Actions');
    const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
    let pr = event.pull_request;
    if (!pr) throw new Error('o evento não é de pull_request');
    const local = Boolean(arg('--files'));
    // No Actions, lê rótulos e corpo atuais: um "Re-run" reaproveita o payload antigo.
    if (!local) pr = await gh(`/repos/${process.env.GITHUB_REPOSITORY}/pulls/${pr.number}`, process.env.GITHUB_TOKEN);

    const config = loadConfig(arg('--config'));
    const labels = (pr.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));
    const files = local
        ? JSON.parse(fs.readFileSync(arg('--files'), 'utf8'))
        : await fetchFiles(process.env.GITHUB_REPOSITORY, pr.number, process.env.GITHUB_TOKEN);
    const template = arg('--template') ?? TEMPLATE;
    const templateBody = fs.existsSync(template) ? fs.readFileSync(template, 'utf8') : '';

    const result = evaluate({ labels, body: pr.body ?? '', files, templateBody, config });
    // Nomes de arquivo vêm do PR: escapa o que viraria workflow command.
    const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    const report = [
        `processo-check: ${result.ok ? 'PASS' : 'FAIL'}`,
        ...result.info.map((l) => `- ${l}`),
        ...result.errors.map((e) => `- ERRO: ${e}`),
    ];
    console.log(report.map(esc).join('\n'));
    if (process.env.GITHUB_ACTIONS === 'true') {
        for (const e of result.errors) console.log(`::error title=processo-check::${esc(e)}`);
        if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report.join('\n')}\n`);
    }
    process.exitCode = result.ok ? 0 : 1;
}

main().catch((e) => {
    console.error(`processo-check: erro de execução: ${e.message}`);
    process.exitCode = 2;
});
