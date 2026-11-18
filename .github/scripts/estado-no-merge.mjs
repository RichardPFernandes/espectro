#!/usr/bin/env node
// estado-no-merge (F0.9 AC-02): no merge de um PR, atualiza a issue do Linear citada em "Refs PRI-N".
// Leve/Médio sem outro PR aberto nem filha aberta → Done + Estado/Próximo passo; com pendência → só
// Estado/Próximo passo; Alto → nada. Modo pela variável ESTADO_NO_MERGE: ausente/off | simular | on.
//
// Uso:
//   ESTADO_NO_MERGE=simular node .github/scripts/estado-no-merge.mjs [--event payload.json | --pr N] [--fake rede.json]
// Sem --event/--pr, lê GITHUB_EVENT_PATH (pull_request ou workflow_dispatch com inputs.pr).
// --fake rede.json = { "issues": { "PRI-N": <issue> }, "pulls": { "N": <pull> } }: rede falsa, sem chamadas reais.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './processo-lib.mjs';
import { parseRefs, levelFromLabels, decide, rewriteEstado, estadoText } from './estado-no-merge-lib.mjs';

const MODES = new Set(['off', 'simular', 'on']);
const OPEN_EXCLUDED = new Set(['completed', 'canceled']);

const isoDate = (d) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Processa o merge de um PR. Não lança: erros viram linhas do resumo e código 1.
 * @param {object} deps
 * @param {Record<string, string|undefined>} deps.env ESTADO_NO_MERGE, GITHUB_REPOSITORY (tokens só para mascarar)
 * @param {object} deps.event payload com `pull_request`, ou `inputs.pr` (workflow_dispatch)
 * @param {{ getIssue(id: string): Promise<object>, updateIssue(id: string, input: object): Promise<unknown> }} deps.linear
 * @param {{ getPull(n: number): Promise<object> }} deps.gh
 * @param {(markdown: string) => void} deps.summary
 * @param {() => Date|string} [deps.now] data usada quando o PR não traz merged_at
 * @param {Record<string, string>} [deps.levels] mapa `levels` do processo.json
 * @returns {Promise<number>} código de saída (0 ou 1)
 */
export async function run({ env, event, linear, gh, summary, now = () => new Date(), levels }) {
    const raw = String(env.ESTADO_NO_MERGE ?? '').trim().toLowerCase();
    const mode = raw === '' ? 'off' : raw;
    if (mode === 'off' || !MODES.has(mode)) {
        summary(`## Estado no merge\n\nDesligado (ESTADO_NO_MERGE=${MODES.has(mode) ? mode : 'valor desconhecido, tratado como off'}).\n`);
        return 0;
    }
    const secrets = [env.LINEAR_API_KEY, env.GITHUB_TOKEN].filter((s) => s && s.length >= 4);
    const clean = (msg) => secrets.reduce((m, s) => m.split(s).join('***'), String(msg));
    const errMsg = (e) => clean(e?.message ?? e);
    const lines = [`## Estado no merge (modo: ${mode})`, ''];
    const finish = (code) => { summary(`${lines.join('\n')}\n`); return code; };

    let pr;
    try {
        const n = Number(event?.inputs?.pr ?? NaN);
        if (event?.pull_request) pr = event.pull_request;
        else if (Number.isInteger(n) && n > 0) pr = await gh.getPull(n);
        else throw new Error('evento sem pull_request nem inputs.pr');
    } catch (e) {
        lines.push(`- ERRO ao ler o PR: ${errMsg(e)}`);
        return finish(1);
    }

    if (!pr.merged) {
        lines.push(`PR #${pr.number} não mesclado: nada a fazer.`);
        return finish(0);
    }
    const level = levelFromLabels(pr.labels, levels ?? loadConfig().levels);
    const data = pr.merged_at ? isoDate(pr.merged_at) : isoDate(now());
    const ids = parseRefs(pr.title, pr.body);
    lines.push(`PR #${pr.number} mesclado em ${data}; nível ${level ?? 'sem rótulo único'}.`, '');
    if (ids.length === 0) {
        lines.push('Sem "Refs PRI-N" no título nem no corpo: nada a fazer.');
        return finish(0);
    }

    const prRe = new RegExp(`^https://github\\.com/${escapeRe(env.GITHUB_REPOSITORY ?? '')}/pull/(\\d+)(?:[/?#]|$)`, 'i');
    let failed = false;
    for (const id of ids) {
        try {
            lines.push(`- ${await processIssue(id)}`);
        } catch (e) {
            failed = true;
            lines.push(`- ${id}: ERRO — ${errMsg(e)}`);
        }
    }
    return finish(failed ? 1 : 0);

    async function processIssue(id) {
        const issue = await linear.getIssue(id);
        if (issue.state?.type === 'canceled') return `${id}: nada — issue cancelada.`;

        let otherOpenPrs = [];
        let openChildren = [];
        if (level === 'leve' || level === 'medio') {
            openChildren = (issue.children ?? []).filter((c) => !OPEN_EXCLUDED.has(c.state?.type)).map((c) => c.identifier);
            const nums = [...new Set((issue.attachments ?? [])
                .map((a) => prRe.exec(a.url ?? '')?.[1]).filter(Boolean).map(Number))].filter((n) => n !== pr.number);
            for (const n of nums) if ((await gh.getPull(n)).state === 'open') otherOpenPrs.push(n);
        }
        const d = decide({ level, otherOpenPrs, openChildren });
        if (d.acao === 'nada') return `${id}: nada — ${d.motivo}.`;

        const input = {};
        if (d.acao === 'done' && issue.state?.type !== 'completed') {
            const done = (issue.team?.states ?? []).find((s) => s.type === 'completed' && s.name === 'Done');
            if (!done) throw new Error('o time da issue não tem estado "Done" (type completed)');
            input.stateId = done.id;
        }
        const rw = rewriteEstado(issue.description, estadoText({ pr: pr.number, data, acao: d.acao, pendencias: d.pendencias }));
        if (rw.changed) input.description = rw.text;

        const efeitos = [
            input.stateId ? 'mover para Done' : d.acao === 'done' ? 'já em Done' : null,
            input.description !== undefined ? 'reescrever Estado e Próximo passo' : null,
        ].filter(Boolean).join(' e ') || 'nenhuma mudança';
        const faltando = rw.missing.length ? `; linhas não achadas: ${rw.missing.join(', ')}` : '';
        let status = 'nada a escrever';
        if (Object.keys(input).length) {
            if (mode === 'on') { await linear.updateIssue(issue.id, input); status = 'escrito'; }
            else status = 'simulado, não escrito';
        }
        return `${id}: ${d.acao} — ${d.motivo}; ${efeitos}${faltando} (${status}).`;
    }
}

// ---- dependências reais ----

function arg(name) {
    const i = process.argv.indexOf(name);
    return i === -1 ? undefined : process.argv[i + 1];
}

const ISSUE_QUERY = `query($id: String!) { issue(id: $id) {
  id identifier description state { type name }
  team { states(first: 100) { nodes { id name type } } }
  children(first: 100) { nodes { identifier state { type } } }
  attachments(first: 100) { nodes { url } }
} }`;
const UPDATE_MUTATION = `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`;

function realLinear(apiKey) {
    async function gql(query, variables) {
        if (!apiKey) throw new Error('LINEAR_API_KEY ausente');
        const res = await fetch('https://api.linear.app/graphql', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: apiKey },
            body: JSON.stringify({ query, variables }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || json.errors?.length) {
            throw new Error(`Linear API ${res.status}${json.errors?.length ? `: ${json.errors.map((e) => e.message).join('; ')}` : ''}`);
        }
        return json.data;
    }
    return {
        async getIssue(id) {
            const { issue } = await gql(ISSUE_QUERY, { id });
            if (!issue) throw new Error(`issue ${id} não encontrada no Linear`);
            return {
                ...issue,
                team: { states: issue.team?.states?.nodes ?? [] },
                children: issue.children?.nodes ?? [],
                attachments: issue.attachments?.nodes ?? [],
            };
        },
        async updateIssue(id, input) {
            const { issueUpdate } = await gql(UPDATE_MUTATION, { id, input });
            if (!issueUpdate?.success) throw new Error('Linear: issueUpdate sem success');
            return true;
        },
    };
}

function realGh(repo, token) {
    return {
        async getPull(n) {
            const url = `/repos/${repo}/pulls/${n}`;
            const res = await fetch(`https://api.github.com${url}`, {
                headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' },
            });
            if (!res.ok) throw new Error(`GitHub API ${res.status} em ${url}`);
            return res.json();
        },
    };
}

function fakeNet(file) {
    const { issues = {}, pulls = {} } = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
        linear: {
            async getIssue(id) {
                if (!issues[id]) throw new Error(`issue ${id} não está no --fake`);
                return issues[id];
            },
            async updateIssue(id, input) {
                console.error(`[fake] issueUpdate ${id} ${JSON.stringify(Object.keys(input))}`);
                return true;
            },
        },
        gh: {
            async getPull(n) {
                if (!pulls[n]) throw new Error(`PR ${n} não está no --fake`);
                return pulls[n];
            },
        },
    };
}

async function main() {
    const { env } = process;
    const prArg = arg('--pr');
    const eventPath = arg('--event') ?? env.GITHUB_EVENT_PATH;
    const event = prArg ? { inputs: { pr: prArg } } : eventPath ? JSON.parse(fs.readFileSync(eventPath, 'utf8')) : {};
    const fake = arg('--fake');
    const net = fake ? fakeNet(fake) : { linear: realLinear(env.LINEAR_API_KEY), gh: realGh(env.GITHUB_REPOSITORY, env.GITHUB_TOKEN) };
    const summary = env.GITHUB_STEP_SUMMARY
        ? (t) => fs.appendFileSync(env.GITHUB_STEP_SUMMARY, t)
        : (t) => process.stdout.write(t);
    return run({ env, event, ...net, summary });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().then((code) => process.exit(code), (e) => {
        console.error(`estado-no-merge: erro de execução: ${e?.message ?? e}`);
        process.exit(1);
    });
}
