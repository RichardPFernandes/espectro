// Elegibilidade do merge automático do Leve (F0.8, PRI-410; SPEC em
// tasks/f0-8-merge-automatico-leve/SPEC.md). Funções puras, sem rede nem
// leitura de arquivo: o workflow de merge, o resumo diário e o /pri-pr chamam
// estas mesmas funções, com a configuração lida da `main` (nunca do PR, AC-01).
//
// Entradas de evaluatePr, no formato da API do GitHub:
//   pr:     GET /repos/{r}/pulls/{n} (o PR individual: a listagem não traz
//           changed_files). Lê só number, state, draft, labels (objetos { name }
//           ou strings), head.sha, head.repo.full_name, base.ref e changed_files.
//   files:  GET /repos/{r}/pulls/{n}/files (todas as páginas, que param em 3000):
//           [{ filename, status, previous_filename? }].
//   checks: { checkRuns, statuses } do head.sha:
//           checkRuns = `check_runs` de GET /repos/{r}/commits/{sha}/check-runs
//                       (todas as páginas): [{ id, name, status, conclusion,
//                       started_at, app: { id, slug } }]. Cada disparo cria um
//                       check suite novo, e filter=latest não tira as execuções
//                       antigas: vale só a mais recente de cada nome;
//           statuses  = `statuses` de GET /repos/{r}/commits/{sha}/status
//                       (o último por contexto): [{ context, state }].
//   config: o objeto de .github/processo.json da `main` (usa levels e mergeLeve).
//   repo:   "dono/nome" do repositório base (GITHUB_REPOSITORY).
import { loadConfig, matchesAny } from './processo-lib.mjs';

export { loadConfig };

const OK_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);
const LEVE = 'processo:leve';

// Veredito por caminho. A negação vence a permissão; removido e renomeado só
// valem para as extensões de `removableExtensions` (no renomeado, o nome
// antigo também precisa estar na lista).
export function pathVerdict(files, cfg) {
    const motivos = [];
    if (!files?.length) return { ok: false, motivos: ['PR sem arquivos'] };
    const { allowedPaths = [], deniedPaths = [], removableExtensions = [] } = cfg ?? {};
    const check = (name) => {
        // Negação sem diferenciar maiúsculas: na dúvida, nega.
        if (matchesAny(name, deniedPaths, { ignoreCase: true })) return `${name}: caminho negado`;
        if (!matchesAny(name, allowedPaths)) return `${name}: fora da lista mergeLeve`;
        return null;
    };
    for (const f of files) {
        const names = [f.filename];
        if (f.status === 'renamed' && f.previous_filename) names.push(f.previous_filename);
        for (const n of names) {
            const m = check(n);
            if (m) motivos.push(m);
        }
        if (f.status === 'removed' || f.status === 'renamed') {
            const word = f.status === 'removed' ? 'removido' : 'renomeado';
            for (const n of names) {
                if (!removableExtensions.some((ext) => n.endsWith(ext))) {
                    motivos.push(`${n}: ${word}, e só ${removableExtensions.join(', ') || '(nada)'} pode ser removido ou renomeado`);
                }
            }
        }
    }
    return { ok: motivos.length === 0, motivos };
}

const ACTIONS_APP_ID = 15368;
const isActions = (c) => c?.app?.id === ACTIONS_APP_ID || c?.app?.slug === 'github-actions';

// Ordem entre duas execuções do mesmo nome: maior id; empate ou id ausente,
// started_at mais novo. 0 quando não dá para saber.
function compareRuns(a, b) {
    if (Number.isFinite(a.id) && Number.isFinite(b.id) && a.id !== b.id) return a.id - b.id;
    const ta = Date.parse(a.started_at ?? '');
    const tb = Date.parse(b.started_at ?? '');
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
    return 0;
}

// Só a execução mais recente de cada nome. Se não dá para dizer qual é a mais
// recente, ficam todas as empatadas, e todas precisam estar verdes.
export function latestRuns(runs) {
    const byName = new Map();
    for (const c of runs) {
        const top = byName.get(c.name);
        const cmp = top ? compareRuns(c, top[0]) : 1;
        if (cmp > 0) byName.set(c.name, [c]);
        else if (cmp === 0) top.push(c);
    }
    return [...byName.values()].flat();
}

function checksVerdict(checks, requiredChecks) {
    const motivos = [];
    const runs = latestRuns(checks?.checkRuns ?? []);
    const statuses = checks?.statuses ?? [];
    // Presença: só check run do GitHub Actions. Commit status ou check de outro
    // app com o mesmo nome não prova que o job do repositório rodou.
    const present = new Set(runs.filter(isActions).map((c) => c.name));
    for (const name of requiredChecks) {
        if (!present.has(name)) motivos.push(`check obrigatório ausente: ${name}`);
    }
    for (const c of runs) {
        if (c.status !== 'completed') motivos.push(`check pendente: ${c.name} (${c.status})`);
        else if (!OK_CONCLUSIONS.has(c.conclusion)) motivos.push(`check sem sucesso: ${c.name} (${c.conclusion})`);
    }
    for (const s of statuses) {
        if (s.state === 'pending') motivos.push(`status pendente: ${s.context}`);
        else if (s.state !== 'success') motivos.push(`status sem sucesso: ${s.context} (${s.state})`);
    }
    return motivos;
}

export function evaluatePr({ pr, files, checks, config, repo }) {
    const cfg = config?.mergeLeve;
    if (!cfg) return { merge: false, motivos: ['configuração da main sem mergeLeve'] };
    const motivos = [];

    const levelLabels = Object.keys(config.levels ?? {});
    const labels = (pr.labels ?? []).map((l) => String(typeof l === 'string' ? l : l?.name).toLowerCase());
    const found = [...new Set(labels.filter((l) => levelLabels.includes(l)))];
    if (found.length !== 1) motivos.push(`precisa de exatamente um rótulo de nível (achou ${found.length}: ${found.join(', ') || 'nenhum'})`);
    else if (found[0] !== LEVE) motivos.push(`rótulo de nível ${found[0]}, não ${LEVE}`);

    if (pr.state !== 'open') motivos.push(`PR não está aberto (${pr.state})`);
    if (pr.draft !== false) motivos.push('PR em draft');
    if (pr.head?.repo?.full_name !== repo) motivos.push(`PR de fork ou de origem desconhecida (${pr.head?.repo?.full_name ?? 'sem repo'})`);
    if (pr.base?.ref !== 'main') motivos.push(`base ${pr.base?.ref}, não main`);

    // A API de arquivos para em 3000: lista que não bate com changed_files, ou
    // que chegou ao teto, pode esconder um caminho negado.
    const n = files?.length ?? 0;
    if (!Number.isInteger(pr.changed_files) || n !== pr.changed_files || n >= 3000) {
        motivos.push(`lista de arquivos incompleta (${n} de ${pr.changed_files})`);
    }
    motivos.push(...pathVerdict(files, cfg).motivos);
    motivos.push(...checksVerdict(checks, cfg.requiredChecks ?? []));
    return { merge: motivos.length === 0, motivos };
}

// Texto vindo do PR (título, nome de arquivo, motivo) dentro do markdown do
// resumo: uma linha só, sem marcação ativa, sem menção nem referência cruzada.
export function escapeMarkdown(s) {
    return String(s)
        .replace(/[\r\n]+/g, ' ')
        .replace(/[\\`*_{}[\]()<>#!|~&]/g, (c) => `\\${c}`)
        .replace(/@/g, '@​');
}

// Resumo diário do merge automático do Leve (AC-03; SPEC item d).
//   merged:   [{ number, title, issue }] mesclados pelo bot desde o último
//             resumo (issue = "PRI-NNN" ou null);
//   eligible: [{ number, title }] Leve abertos, fora de draft, que a
//             elegibilidade aceita e o bot ainda não mesclou (em simulação, os
//             que ele mesclaria);
//   skipped:  [{ number, title, motivos[] }] Leve fora de draft que a
//             elegibilidade recusa;
//   date:     "AAAA-MM-DD" do dia do resumo.
// Devolve markdown, ou null quando as três listas estão vazias (dia vazio não comenta).
export function buildDailySummary({ merged = [], skipped = [], eligible = [], date }) {
    if (!merged.length && !skipped.length && !eligible.length) return null;
    const lines = [`## Merge automático do Leve: ${escapeMarkdown(date)}`, ''];
    lines.push(`### Mesclados pelo bot desde o último resumo (${merged.length})`, '');
    if (!merged.length) lines.push('Nenhum.');
    for (const m of merged) {
        lines.push(`- #${Number(m.number)} ${escapeMarkdown(m.title)} (${m.issue ? escapeMarkdown(m.issue) : 'sem issue citada'})`);
    }
    lines.push('', `### Elegível, não mesclado (${eligible.length})`, '');
    if (!eligible.length) lines.push('Nenhum.');
    for (const e of eligible) {
        lines.push(`- #${Number(e.number)} ${escapeMarkdown(e.title)}`);
    }
    lines.push('', `### Leve que ficou de fora (${skipped.length})`, '');
    if (!skipped.length) lines.push('Nenhum.');
    for (const s of skipped) {
        lines.push(`- #${Number(s.number)} ${escapeMarkdown(s.title)}: ${s.motivos.map(escapeMarkdown).join('; ')}`);
    }
    return `${lines.join('\n')}\n`;
}
