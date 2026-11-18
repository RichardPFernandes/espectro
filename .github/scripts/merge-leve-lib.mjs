// Elegibilidade do merge automático do Leve (F0.8, PRI-410; SPEC em
// tasks/f0-8-merge-automatico-leve/SPEC.md). Funções puras, sem rede nem
// leitura de arquivo: o workflow de merge, o resumo diário e o /pri-pr chamam
// estas mesmas funções, com a configuração lida da `main` (nunca do PR, AC-01).
//
// Entradas de evaluatePr, no formato da API do GitHub:
//   pr:     GET /repos/{r}/pulls/{n}. Lê só number, state, draft, labels
//           (objetos { name } ou strings), head.sha, head.repo.full_name e base.ref.
//   files:  GET /repos/{r}/pulls/{n}/files (todas as páginas):
//           [{ filename, status, previous_filename? }].
//   checks: { checkRuns, statuses } do head.sha:
//           checkRuns = `check_runs` de GET /repos/{r}/commits/{sha}/check-runs
//                       (filter=latest, o padrão): [{ name, status, conclusion }];
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

function checksVerdict(checks, requiredChecks) {
    const motivos = [];
    const runs = checks?.checkRuns ?? [];
    const statuses = checks?.statuses ?? [];
    const present = new Set([...runs.map((c) => c.name), ...statuses.map((s) => s.context)]);
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

    motivos.push(...pathVerdict(files, cfg).motivos);
    motivos.push(...checksVerdict(checks, cfg.requiredChecks ?? []));
    return { merge: motivos.length === 0, motivos };
}
