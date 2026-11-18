#!/usr/bin/env node
// merge-leve-resumo: resumo diário do merge automático do Leve (F0.8, PRI-410;
// AC-03, SPEC item d). Roda no cron das 08:00 BRT e lista, num comentário da
// issue fixa "Merge automático do Leve: resumo" (a aberta, criada por
// github-actions[bot], de menor número):
//   - os PRs mesclados por github-actions[bot] desde o último comentário do bot
//     na issue fixa (sem issue ou sem comentário, nas últimas 24 h);
//   - os PRs Leve abertos e fora de draft que a elegibilidade aceita e ainda não
//     foram mesclados (em simulação, os que o bot mesclaria);
//   - os PRs Leve abertos e fora de draft que a elegibilidade recusa, com o motivo.
// Dia sem nada não comenta. Só lê PRs, checks e a issue fixa; a única escrita é
// a issue fixa (criada só quando há resumo) e o comentário. Não lê MERGE_LEVE.
// A rede entra pelo parâmetro `gh(method, path, body)` (makeGh do merge-leve.mjs).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDailySummary, evaluatePr, loadConfig } from './merge-leve-lib.mjs';
import { checksOf, esc, makeGh, paginate } from './merge-leve.mjs';

export const ISSUE_TITLE = 'Merge automático do Leve: resumo';
const BOT = 'github-actions[bot]';
const LEVE = 'processo:leve';
const DAY_MS = 24 * 3600e3;

const issueOf = (title) => String(title ?? '').match(/\bPRI-\d+\b/i)?.[0].toUpperCase() ?? null;
const labelNames = (pr) => (pr.labels ?? []).map((l) => String(typeof l === 'string' ? l : l?.name).toLowerCase());

async function mergedByBot(gh, repo, since) {
    // Fechados, do mais recente para o mais antigo; para quando a página já
    // passou da janela. A listagem não traz merged_by: busca cada candidato.
    const closed = await paginate(gh, `/repos/${repo}/pulls?state=closed&sort=updated&direction=desc`, (b) => b,
        (batch) => new Date(batch[batch.length - 1]?.updated_at) < since);
    const merged = [];
    for (const c of closed) {
        if (!c.merged_at || new Date(c.merged_at) < since) continue;
        const pr = await gh('GET', `/repos/${repo}/pulls/${c.number}`);
        if (pr.merged_by?.login !== BOT) continue;
        merged.push({ number: pr.number, title: pr.title, issue: issueOf(pr.title) });
    }
    return merged.sort((a, b) => a.number - b.number);
}

async function openLeve(gh, repo, config) {
    const open = await paginate(gh, `/repos/${repo}/pulls?state=open`, (b) => b);
    const skipped = [];
    const eligible = [];
    for (const item of open) {
        if (item.draft !== false || !labelNames(item).includes(LEVE)) continue;
        // A listagem não traz changed_files, que evaluatePr exige: lê o PR.
        const pr = await gh('GET', `/repos/${repo}/pulls/${item.number}`);
        const files = await paginate(gh, `/repos/${repo}/pulls/${pr.number}/files`, (b) => b);
        const checks = await checksOf(gh, repo, pr.head?.sha);
        const { merge, motivos } = evaluatePr({ pr, files, checks, config, repo });
        if (merge) eligible.push({ number: pr.number, title: pr.title });
        else skipped.push({ number: pr.number, title: pr.title, motivos });
    }
    const byNumber = (a, b) => a.number - b.number;
    return { skipped: skipped.sort(byNumber), eligible: eligible.sort(byNumber) };
}

// A issue fixa: aberta, com o título exato, criada pelo bot; a de menor número.
// Issue de outro autor com o mesmo título não conta. null se não houver.
async function findFixedIssue(gh, repo) {
    const issues = await paginate(gh, `/repos/${repo}/issues?state=open`, (b) => b);
    const numbers = issues
        .filter((i) => !i.pull_request && i.title === ISSUE_TITLE && i.user?.login === BOT)
        .map((i) => Number(i.number));
    return numbers.length ? Math.min(...numbers) : null;
}

// created_at do último comentário do bot na issue fixa, ou null.
async function lastBotComment(gh, repo, issue) {
    const comments = await paginate(gh, `/repos/${repo}/issues/${issue}/comments`, (b) => b);
    const times = comments
        .filter((c) => c.user?.login === BOT)
        .map((c) => Date.parse(c.created_at))
        .filter(Number.isFinite);
    return times.length ? new Date(Math.max(...times)) : null;
}

async function createFixedIssue(gh, repo) {
    const created = await gh('POST', `/repos/${repo}/issues`, {
        title: ISSUE_TITLE,
        body: 'Resumo diário do merge automático do Leve (F0.8): um comentário por dia com o que o bot mesclou e o que ficou de fora.',
    });
    return created.number;
}

export async function run({ env = process.env, gh, config, now = new Date(), log = console.log }) {
    const repo = env.GITHUB_REPOSITORY;
    if (!repo) throw new Error('sem GITHUB_REPOSITORY');
    // Procura a issue sem criar: a janela começa no último resumo do bot.
    const found = await findFixedIssue(gh, repo);
    const last = found === null ? null : await lastBotComment(gh, repo, found);
    const since = last ?? new Date(now.getTime() - DAY_MS);
    const merged = await mergedByBot(gh, repo, since);
    const { skipped, eligible } = await openLeve(gh, repo, config);
    const body = buildDailySummary({ merged, skipped, eligible, date: now.toISOString().slice(0, 10) });
    if (body === null) {
        log(`merge-leve-resumo: nada desde ${since.toISOString()}, sem comentário`);
        return { commented: false };
    }
    const issue = found ?? await createFixedIssue(gh, repo);
    await gh('POST', `/repos/${repo}/issues/${issue}/comments`, { body });
    log(`merge-leve-resumo: comentário na issue #${issue} (${merged.length} mesclado(s), ${eligible.length} elegível(is), ${skipped.length} de fora)`);
    return { commented: true, issue };
}

async function main() {
    const env = process.env;
    if (!env.GITHUB_TOKEN) throw new Error('sem GITHUB_TOKEN');
    // .github/processo.json do checkout local, que no workflow é a `main` (AC-01).
    await run({ env, gh: makeGh(env.GITHUB_TOKEN), config: loadConfig(), now: new Date() });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((e) => {
        console.error(`merge-leve-resumo: erro de execução: ${esc(e.message)}`);
        process.exitCode = 2;
    });
}
