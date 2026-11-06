'use strict';
// Writer SDD (PRI-266) — host SIMULADO, só para testes (plano de fatias r4, "Host simulado").
// Repo Git bare em TMPDIR + contrato HP-1…HP-8 do contrato PRI-231 r4 C-06:
//   HP-1 merge serializado estrito (base atualizada), só merge-commit/squash, W-C PASS
//        sobre (árvore, base) da identidade confiável; rebase/fast-forward recusados.
//   HP-2 status só da identidade do W-C; push direto só por "admin" (adminPush).
//   HP-3 criação de ref só se ausente (desligável: fallback D-231-2 B).
//   HP-4 tags sdd/** com criador verificável (anotada pelo W-A); tag leve sem criador.
//   HP-6 leitura de PR/ref/status; falha injetável (erro distinguível de "não existe").
//   HP-7 W-C executado com o código da BASE (materializado do commit), nunca do PR.
//   HP-8 metadados do PR (autor, branch, número) verificáveis.
// Nenhuma rede, nenhum host real (F8 fora, D-266-2 A).

const fs = require('node:fs');
const path = require('node:path');
const { makeGit, UnverifiableError } = require('./sdd-writer-git');
const { tmpDir, writerFiles, LIB } = require('./sdd-writer-testkit');
const cmd = require('./sdd-writer-command');
const { DEFAULT_IDENTITIES } = require('./sdd-writer-audit');

const CODE_PREFIX = 'scripts/lib';
const SUPPORT = ['spec-hash.js', 'spec-headings.js'];

/** Arquivos de código do writer como existem no checkout (semeiam a base do repo simulado). */
function writerCodeFiles() {
    const out = {};
    for (const f of [...writerFiles(), ...SUPPORT]) out[`${CODE_PREFIX}/${f}`] = fs.readFileSync(path.join(LIB, f));
    return out;
}

function createHost({ hp3 = true, identities = DEFAULT_IDENTITIES, registryBranch = 'main' } = {}) {
    const dir = tmpDir('sdd-host-');
    const git = makeGit(dir, { identity: 'host-sim' });
    git.run(['init', '-q', '--bare', '-b', registryBranch]);
    const prs = [];
    const statuses = new Map();
    const tags = new Map();
    const comments = [];
    const faults = { api: false };
    const codeCache = new Map();
    const guard = () => { if (faults.api) throw new UnverifiableError('HOST_API', 'falha injetada da API do host'); };
    const refOf = name => git.resolveCommit(name);
    const mainRef = `refs/heads/${registryBranch}`;

    /** Commit com a árvore = código do writer + `files` (mapa completo de caminhos). */
    function commitFiles(files, parents, message, who = 'richard', { withCode = true } = {}) {
        const all = { ...(withCode ? writerCodeFiles() : {}), ...files };
        const tree = git.buildTree(null, all);
        return git.commitTree(tree, parents, message, who);
    }

    const host = {
        git, dir, prs, statuses, tags, comments, faults, identities, registryBranch, hp3,
        // ---- HP-6 ----
        async getRef(name) { guard(); return refOf(name); },
        async getStatus(tree, base) { guard(); return statuses.get(`${tree}|${base || 'ROOT'}`) || null; },
        async prsByBranch(branch) { guard(); return prs.filter(p => p.branch === branch); },
        async listAnchors(project, slug) {
            guard();
            const prefix = `sdd/${project}/${slug}/g`;
            return [...tags.entries()].filter(([n]) => n.startsWith(prefix))
                .map(([name, t]) => ({ name, gen: Number(name.slice(prefix.length)), commit: t.commit, creator: t.creator }));
        },
        async listMarkers(project) {
            guard();
            return git.listRefs(`refs/heads/sdd-op/${project}/`);
        },
        // ---- HP-3 ----
        async createRefIfAbsent(name, sha) {
            guard();
            // @guard HP-3
            if (hp3 && refOf(name)) return false;
            // @end HP-3
            git.run(['update-ref', name, sha]);
            return true;
        },
        async deleteRef(name) { guard(); git.run(['update-ref', '-d', name]); },
        // ---- HP-4 ----
        async createTag(name, commit, identity) {
            guard();
            if (tags.has(name)) return false;
            tags.set(name, { commit, creator: identity });
            git.run(['update-ref', `refs/tags/${name}`, commit]);
            return true;
        },
        /** Tag leve ou forjada (admin): criador ilegível ou outro. */
        forgeTag(name, commit, creator = null) { tags.set(name, { commit, creator }); git.run(['update-ref', `refs/tags/${name}`, commit]); },
        deleteTagAdmin(name) { tags.delete(name); git.run(['update-ref', '-d', `refs/tags/${name}`]); },
        // ---- PRs (HP-8) ----
        async openPR({ branch, author, head }) {
            guard();
            const pr = { number: prs.length + 1, branch, author, head: head || refOf(`refs/heads/${branch}`), state: 'OPEN', base: registryBranch, verified: true, checkRuns: 0 };
            prs.push(pr);
            return pr;
        },
        async closePR(n) { guard(); prs[n - 1].state = 'CLOSED'; },
        async rerunCheck(n) { guard(); prs[n - 1].checkRuns += 1; return prs[n - 1].checkRuns; },
        async comment(text) { guard(); comments.push(text); },
        // ---- simulação ----
        commitFiles,
        seed(files) {
            const c = commitFiles(files, [], 'seed', 'richard');
            git.run(['update-ref', mainRef, c]);
            return c;
        },
        tip() { return refOf(mainRef); },
        /** PR com a árvore `files` sobre o tip atual (sem passar pelo W-P). */
        propose(files, { branch, author = 'richard', extra = {}, withCode = true } = {}) {
            const c = commitFiles(files, [refOf(mainRef)], `proposta ${branch}`, author, { withCode });
            git.run(['update-ref', `refs/heads/${branch}`, c]);
            const pr = { number: prs.length + 1, branch, author, head: c, state: 'OPEN', base: registryBranch, verified: true, checkRuns: 0, ...extra };
            prs.push(pr);
            return pr;
        },
        /** HP-7: carrega o W-C do commit `sha` (base), nunca do PR. */
        loadCheckFrom(sha) {
            if (codeCache.has(sha)) return codeCache.get(sha);
            const d = tmpDir('sdd-wc-code-');
            for (const [p] of git.listFiles(sha, CODE_PREFIX)) {
                const name = p.slice(CODE_PREFIX.length + 1);
                if (name.includes('/')) continue;
                fs.writeFileSync(path.join(d, name), git.readBlob(sha, p));
            }
            const mod = require(path.join(d, 'sdd-writer-check.js'));
            const digest = cmd.sha256hex(Buffer.from(fs.readdirSync(d).sort().map(f => cmd.sha256hex(fs.readFileSync(path.join(d, f)))).join('')));
            const entry = { mod, digest };
            codeCache.set(sha, entry);
            return entry;
        },
        /** Roda o W-C do PR sobre o tip atual e registra o status por (árvore, base). */
        async runCheck(n, { decisionPort, testOnly = {}, codeFrom = 'base' } = {}) {
            const pr = prs[n - 1];
            const base = refOf(mainRef);
            const tree = git.treeOf(pr.head);
            // HP-1 estrito: a árvore avaliada é a do head construído sobre a base atual.
            if (git.firstParent(pr.head) !== base) return { status: 'FAIL', code: 'BEHIND', reason: 'BASE_DESATUALIZADA' };
            // @guard HP-7
            const { mod, digest } = host.loadCheckFrom(base);
            // @else
            // const { mod, digest } = host.loadCheckFrom(pr.head);
            // @end HP-7
            void codeFrom;
            const res = await mod.checkIntegration({
                git, host, baseSha: base, resultTree: tree, decisionPort, hp3, identities, testOnly,
                pr: { target: pr.base, author: pr.author, branch: pr.branch, number: pr.number, verified: pr.verified, batchProtected: pr.batchProtected },
            });
            const status = { state: res.status, code: res.code || null, identity: identities.wc, codeDigest: digest, base, tree };
            statuses.set(`${tree}|${base}`, status);
            return { ...res, codeDigest: digest };
        },
        /** HP-1: merge só com base atualizada e W-C PASS sobre (árvore, base); só merge/squash. */
        async merge(n, mode = 'squash') {
            const pr = prs[n - 1];
            if (pr.state !== 'OPEN') return { merged: false, reason: 'NOT_OPEN' };
            if (mode !== 'merge' && mode !== 'squash') return { merged: false, reason: 'MODE_NOT_ALLOWED' };
            const base = refOf(mainRef);
            if (git.firstParent(pr.head) !== base) return { merged: false, reason: 'BEHIND' };
            const tree = git.treeOf(pr.head);
            const st = statuses.get(`${tree}|${base}`);
            if (!st || st.state !== 'PASS' || st.identity !== identities.wc) return { merged: false, reason: 'NO_WC_PASS' };
            const parents = mode === 'merge' ? [base, pr.head] : [base];
            const c = git.commitTree(tree, parents, `merge #${n}`, 'host-merge');
            git.run(['update-ref', mainRef, c, base]);
            pr.state = 'MERGED';
            pr.mergeCommit = c;
            return { merged: true, commit: c };
        },
        /** Push de admin (bypass): não pode ser impedido (EM §3 prop. 6). */
        adminPush(sha) { git.run(['update-ref', mainRef, sha]); },
    };
    return host;
}

/**
 * Ambiente de teste: host simulado semeado com um cenário de fixtures e porta de Decision
 * de teste cujos registros acumulam a cada proposta.
 */
function makeEnv({ hp3 = true, scenarioOpts = {}, seedFiles = null, hostImpl = createHost } = {}) {
    const { fixtures } = require('./sdd-writer-testkit');
    const { createTestDecisionPort } = require('./sdd-writer-decision');
    const host = hostImpl({ hp3 });
    const s = fixtures.scenario(scenarioOpts);
    host.seed(seedFiles || s.state.files);
    const records = {};
    const port = createTestDecisionPort(records);
    const env = {
        host, git: host.git, s, records, port,
        propose(st, { branch, author, extra, files } = {}) {
            Object.assign(records, st.records);
            return host.propose(files || st.files, { branch: branch || cmd.markerBranch(s.project, s.slug), author: author || st.entry.actor, extra });
        },
        check(pr, testOnly = {}) { return host.runCheck(pr.number, { decisionPort: port, testOnly }); },
        async integrate(st, { testOnly = {}, mode = 'squash', ...opts } = {}) {
            const pr = env.propose(st, opts);
            const res = await env.check(pr, testOnly);
            let merge = null;
            if (res.status === 'PASS') {
                merge = await host.merge(pr.number, mode);
                if (merge.merged) s.commit(st);
            }
            return { pr, res, merge };
        },
    };
    return env;
}

module.exports = { createHost, writerCodeFiles, makeEnv };
