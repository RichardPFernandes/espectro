#!/usr/bin/env node
// Rastreabilidade reversa: dado um arquivo, quais tickets o tocaram (e por qual spec/PR).
//
//   node scripts/trace.js src/main/java/br/com/mosistemas/.../CalculoFreteService.java [--json]
//
// Três fontes, na ordem de confiança:
//   1. memory/knowledge-graph.json (scripts/lib/knowledge-graph.js) — ticket → spec → PR;
//   2. comentários `// @spec ...` no topo do próprio arquivo (gravados pelo /commit);
//   3. fallback `git log --follow` do arquivo: números de ticket (4-6 dígitos) e de PR
//      ("pull request #N") no assunto dos commits — cobre o que é anterior ao grafo.
// Caminho pode ser absoluto, relativo, de dentro de um worktree de ticket, ou
// prefixado com o repo irmão ("app-core/src/..."). Só lê; exit 0 = ok, 2 = uso incorreto.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const kg = require('./lib/knowledge-graph');

const SPEC_TAG_RE = /^\s*\/\/\s*@spec\s+(\S+)\s*\|\s*redmine:(\S+)\s*\|\s*pr:(\S+)/;
const TICKET_IN_SUBJECT_RE = /(?:^|[^\d])#?(\d{5,6})(?!\d)/g;
const PR_IN_SUBJECT_RE = /pull request #(\d+)/i;

function specTagsOf(absFile) {
    let text;
    try { text = fs.readFileSync(absFile, 'utf8'); } catch { return []; }
    const out = [];
    for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
        const m = SPEC_TAG_RE.exec(line);
        if (!m) break; // só o bloco do topo
        out.push({ spec: m[1], redmine: m[2], pr: m[3] });
    }
    return out;
}

// Repo + caminho relativo dentro dele, a partir do id normalizado.
function locate(fileId, mainRepo) {
    const workspace = path.dirname(mainRepo);
    const [first, ...rest] = fileId.split('/');
    if ((process.env.WATCHER_SIBLING_REPOS || '').split(',').map(s => s.trim()).includes(first) && rest.length) {
        return { repo: first, repoDir: path.join(workspace, first), rel: rest.join('/') };
    }
    return { repo: process.env.WATCHER_MAIN_REPO_NAME || path.basename(mainRepo), repoDir: mainRepo, rel: fileId };
}

function gitHistory(repoDir, rel) {
    let out;
    try {
        out = execFileSync('git', ['log', '--follow', '--date=short', '--format=%h%x09%ad%x09%s', '--', rel],
            { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 });
    } catch { return []; }
    return out.split('\n').filter(Boolean).map(l => {
        const [sha, date, ...s] = l.split('\t');
        const subject = s.join('\t');
        const tickets = [...new Set([...subject.matchAll(TICKET_IN_SUBJECT_RE)].map(m => m[1]))];
        const pr = PR_IN_SUBJECT_RE.exec(subject)?.[1] || null;
        return { sha, date, subject, tickets, pr };
    });
}

function trace(fileArg, { mainRepo = kg.mainRepoOf(process.cwd()), graphPath = kg.defaultGraphPath(mainRepo) } = {}) {
    // realpath: o git devolve caminhos resolvidos (/private/var no macOS, symlinks).
    const abs = fs.existsSync(fileArg) ? fs.realpathSync(fileArg) : path.resolve(fileArg);
    let graph = kg.emptyGraph();
    let graphError = null;
    try { graph = kg.readGraph(graphPath); } catch (e) { graphError = e.message; }

    let fileId = kg.normalizeFilePath(fs.existsSync(abs) ? abs : fileArg, mainRepo);
    // Só o nome (ou um sufixo do caminho): se o grafo conhece um único arquivo com esse
    // final, usa o caminho completo dele — senão o git log não acharia nada.
    if (!fs.existsSync(abs)) {
        const hits = Object.keys(graph.nodes).filter(id => graph.nodes[id].type === 'file' && (id === fileId || id.endsWith(`/${fileId}`)));
        if (hits.length === 1) fileId = hits[0];
    }
    const where = locate(fileId, mainRepo);
    const onDisk = fs.existsSync(abs) ? abs : path.join(where.repoDir, where.rel);
    const sub = kg.subgraphForFile(graph, fileId, mainRepo);
    const tickets = Object.entries(sub.nodes).filter(([, n]) => n.type === 'ticket').map(([id, n]) => {
        const out = sub.edges.filter(e => e.from === id);
        const touch = out.find(e => e.rel === 'touched_file' && (e.to === fileId || e.to.endsWith(`/${fileId}`)));
        return {
            id, title: n.title || null, redmine_url: n.redmine_url || null, touched_at: touch?.at || null,
            specs: out.filter(e => e.rel === 'generated_spec').map(e => e.to),
            prs: out.filter(e => e.rel === 'opened_pr').map(e => ({ id: e.to, ...sub.nodes[e.to] })),
        };
    }).sort((a, b) => String(b.touched_at).localeCompare(String(a.touched_at)));

    return {
        file: fileId, repo: where.repo, graphPath, graphError,
        tickets, specTags: specTagsOf(onDisk), gitLog: gitHistory(where.repoDir, where.rel),
    };
}

function format(r) {
    const lines = [`Arquivo: ${r.file} (${r.repo})`, ''];
    lines.push(`Knowledge Graph (${r.graphPath}):`);
    if (r.graphError) lines.push(`  ! não deu pra ler: ${r.graphError}`);
    else if (!r.tickets.length) lines.push('  (nenhum ticket registrado para este arquivo)');
    for (const t of r.tickets) {
        lines.push(`  ${t.id}${t.title ? ` — ${t.title}` : ''}${t.touched_at ? `  [${t.touched_at.slice(0, 10)}]` : ''}`);
        if (t.redmine_url) lines.push(`    redmine: ${t.redmine_url}`);
        for (const s of t.specs) lines.push(`    spec:    ${s}`);
        for (const p of t.prs) lines.push(`    pr:      ${p.id}${p.status ? ` (${p.status})` : ''}${p.url ? ` ${p.url}` : ''}`);
    }
    lines.push('', 'Comentários @spec no arquivo:');
    if (!r.specTags.length) lines.push('  (nenhum)');
    for (const t of r.specTags) lines.push(`  ${t.redmine}  ${t.spec}  ${t.pr}`);
    lines.push('', 'Fallback git log:');
    const withTicket = r.gitLog.filter(c => c.tickets.length || c.pr);
    if (!r.gitLog.length) lines.push('  (sem histórico git — arquivo novo ou fora do repo)');
    else if (!withTicket.length) lines.push(`  (${r.gitLog.length} commit(s), nenhum cita ticket ou PR no assunto)`);
    for (const c of withTicket) {
        const refs = [...c.tickets.map(t => `#${t}`), c.pr ? `PR ${c.pr}` : null].filter(Boolean).join(' ');
        lines.push(`  ${c.date} ${c.sha}  ${refs.padEnd(18)} ${c.subject}`);
    }
    const all = new Set([...r.tickets.map(t => t.id.replace(/^TASK-/, '')), ...r.specTags.map(t => t.redmine.replace(/^#/, '')), ...r.gitLog.flatMap(c => c.tickets)]);
    all.delete('-');
    lines.push('', `Tickets: ${all.size ? [...all].map(t => `#${t}`).join(', ') : '(nenhum encontrado)'}`);
    return lines.join('\n');
}

function main(argv) {
    const file = argv.find(a => !a.startsWith('--'));
    if (!file) {
        console.error('uso: node scripts/trace.js <arquivo> [--json]');
        return 2;
    }
    const r = trace(file);
    console.log(argv.includes('--json') ? JSON.stringify(r, null, 2) : format(r));
    return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { trace, format, specTagsOf, gitHistory, main };
