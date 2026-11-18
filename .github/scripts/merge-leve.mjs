#!/usr/bin/env node
// merge-leve: merge automático do Leve (F0.8, PRI-410; SPEC em
// tasks/f0-8-merge-automatico-leve/SPEC.md, item c). Roda no workflow_run do
// `Tests` e do `processo-check`, avalia cada PR do commit com evaluatePr e a
// configuração do checkout local (a `main`; nada do PR, AC-01) e:
//   - com MERGE_LEVE=on, mescla o elegível (squash, preso ao sha avaliado);
//   - com qualquer outro valor ou ausente, só escreve o que faria (AC-04).
// Modo local do /pri-pr (AC-06): `--paths <name-status> --config <processo.json>`
// imprime `elegível` ou `draft: <motivos>` só com pathVerdict, sem rede nem token.
// A rede entra pelo parâmetro `gh(method, path, body)`, que rejeita com
// `err.status` em resposta não 2xx; os testes passam um falso.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeMarkdown, evaluatePr, loadConfig, pathVerdict } from './merge-leve-lib.mjs';
import { matchesAny } from './processo-lib.mjs';

const ROADMAP_PATHS = ['ROADMAP.md', 'roadmap/**'];
const RETRY_LATER = new Set([405, 409]);

// O que vem do PR (nomes de arquivo, rótulos, checks) não pode quebrar a linha:
// forjaria uma linha no resumo ou um workflow command no log.
export const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
// No resumo do job (markdown), também sem link, imagem, HTML nem menção.
const md = (s) => escapeMarkdown(esc(s));

// Todas as páginas de uma listagem (100 por página). `until(batch)` verdadeiro
// para depois da página atual (listagens ordenadas, como as do resumo diário).
export async function paginate(gh, url, pick, until = () => false) {
    const all = [];
    const sep = url.includes('?') ? '&' : '?';
    for (let page = 1; ; page++) {
        const batch = pick(await gh('GET', `${url}${sep}per_page=100&page=${page}`)) ?? [];
        all.push(...batch);
        if (batch.length < 100 || until(batch)) return all;
    }
}

// Check-runs e status do sha, no formato que evaluatePr espera.
export async function checksOf(gh, repo, sha) {
    return {
        checkRuns: await paginate(gh, `/repos/${repo}/commits/${sha}/check-runs`, (b) => b?.check_runs),
        statuses: await paginate(gh, `/repos/${repo}/commits/${sha}/status`, (b) => b?.statuses),
    };
}

async function prsOf(gh, repo, wr) {
    const listed = wr.pull_requests ?? [];
    const prs = listed.length ? listed : await gh('GET', `/repos/${repo}/commits/${wr.head_sha}/pulls`);
    const numbers = (prs ?? []).filter((p) => !p.state || p.state === 'open').map((p) => Number(p.number));
    return [...new Set(numbers)];
}

export async function run({ event, env = process.env, gh, config, log = console.log, summary = () => {} }) {
    const repo = env.GITHUB_REPOSITORY;
    const wr = event?.workflow_run;
    if (!repo) throw new Error('sem GITHUB_REPOSITORY');
    if (!wr) throw new Error('o evento não é workflow_run');
    const live = env.MERGE_LEVE === 'on';
    const lines = [`merge-leve: ${live ? 'MERGE_LEVE=on' : 'simulação (MERGE_LEVE não é on)'}`];
    try {
        const numbers = await prsOf(gh, repo, wr);
        if (!numbers.length) lines.push(`- nenhum PR aberto para o commit ${md(wr.head_sha)}`);
        for (const n of numbers) {
            const first = await gh('GET', `/repos/${repo}/pulls/${n}`);
            const sha = first.head?.sha;
            const files = await paginate(gh, `/repos/${repo}/pulls/${n}/files`, (b) => b);
            const checks = await checksOf(gh, repo, sha);
            // Arquivos e checks são do sha da primeira leitura: se entrou commit
            // no meio, a avaliação não vale para o PR de agora.
            const pr = await gh('GET', `/repos/${repo}/pulls/${n}`);
            if (pr.head?.sha !== sha) { lines.push(`- #${n} mudou, fica para a próxima rodada (commit novo durante a avaliação)`); continue; }
            const { merge, motivos } = evaluatePr({ pr, files, checks, config, repo });
            if (!merge) { lines.push(`- não #${n}: ${md(motivos.join('; '))}`); continue; }
            if (!live) { lines.push(`- mesclaria #${n}`); continue; }
            try {
                await gh('PUT', `/repos/${repo}/pulls/${n}/merge`, { merge_method: 'squash', sha });
            } catch (e) {
                if (!RETRY_LATER.has(e.status)) throw e;
                lines.push(`- #${n} mudou, fica para a próxima rodada (${e.status})`);
                continue;
            }
            lines.push(`- mesclado #${n} (${md(sha)})`);
            const names = files.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean));
            if (names.some((name) => matchesAny(name, ROADMAP_PATHS))) {
                // Push do GITHUB_TOKEN não dispara outros workflows: publica à mão.
                await gh('POST', `/repos/${repo}/actions/workflows/roadmap-pages.yml/dispatches`, { ref: 'main' });
                lines.push(`- roadmap-pages disparado depois de #${n}`);
            }
        }
    } finally {
        const text = `${lines.join('\n')}\n`;
        log(text.trimEnd());
        summary(text);
    }
}

// Saída de `git diff -M --name-status` no formato de arquivos da API do GitHub.
// Cópia vira `added` do nome novo; letra desconhecida ou linha malformada vira
// motivo de draft, nunca elegível.
const NAME_STATUS = { A: 'added', M: 'modified', T: 'modified', D: 'removed' };
export function parseNameStatus(text) {
    const files = [];
    const motivos = [];
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        const [code = '', ...names] = line.replace(/\r$/, '').split('\t');
        const letter = code[0];
        if ((letter === 'R' || letter === 'C') && names.length === 2) {
            files.push(letter === 'R'
                ? { filename: names[1], status: 'renamed', previous_filename: names[0] }
                : { filename: names[1], status: 'added' });
        } else if (NAME_STATUS[letter] && code.length === 1 && names.length === 1) {
            files.push({ filename: names[0], status: NAME_STATUS[letter] });
        } else {
            motivos.push(`linha de name-status não reconhecida: ${line}`);
        }
    }
    return { files, motivos };
}

export function localVerdict(nameStatus, processo) {
    const cfg = processo?.mergeLeve;
    if (!cfg) return 'draft: configuração da main sem mergeLeve';
    const { files, motivos } = parseNameStatus(nameStatus);
    const all = [...motivos, ...pathVerdict(files, cfg).motivos];
    return all.length ? `draft: ${esc(all.join('; '))}` : 'elegível';
}

function argOf(argv, flag) {
    const i = argv.indexOf(flag);
    if (i < 0 || !argv[i + 1]) throw new Error(`falta ${flag} <arquivo>`);
    return argv[i + 1];
}

export function makeGh(token, fetchImpl = fetch) {
    return async (method, url, body) => {
        const res = await fetchImpl(`https://api.github.com${url}`, {
            method,
            headers: {
                accept: 'application/vnd.github+json',
                authorization: `Bearer ${token}`,
                'x-github-api-version': '2022-11-28',
                ...(body ? { 'content-type': 'application/json' } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
        });
        if (!res.ok) throw Object.assign(new Error(`GitHub API ${res.status} em ${method} ${url}`), { status: res.status });
        const text = await res.text();
        return text ? JSON.parse(text) : null;
    };
}

async function main() {
    const argv = process.argv.slice(2);
    if (argv.length) {
        if (!argv.includes('--paths')) throw new Error(`argumento desconhecido: ${argv[0]}`);
        const nameStatus = fs.readFileSync(argOf(argv, '--paths'), 'utf8');
        const processo = JSON.parse(fs.readFileSync(argOf(argv, '--config'), 'utf8'));
        console.log(localVerdict(nameStatus, processo));
        return;
    }
    const env = process.env;
    if (!env.GITHUB_TOKEN) throw new Error('sem GITHUB_TOKEN');
    if (!env.GITHUB_EVENT_PATH) throw new Error('sem GITHUB_EVENT_PATH: rode no GitHub Actions');
    const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
    await run({
        event,
        env,
        gh: makeGh(env.GITHUB_TOKEN),
        // .github/processo.json do checkout local, que no workflow é a `main` (AC-01).
        config: loadConfig(),
        log: console.log,
        summary: (t) => { if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, t); },
    });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((e) => {
        console.error(`merge-leve: erro de execução: ${esc(e.message)}`);
        process.exitCode = 2;
    });
}
