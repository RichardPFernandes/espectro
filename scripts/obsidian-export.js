#!/usr/bin/env node
// Exporta specs, docs, skills e tarefas do Espectro para um vault do Obsidian (PRI-373, filha da PRI-73).
// Projeção somente leitura: lê só arquivos rastreados pelo git, nunca escreve no repositório e não
// volta nada do vault para a fonte. Offline: não chama o Linear nem o app.
//
//   node scripts/obsidian-export.js --out <pasta-do-vault> [--repo <raiz>]
//
// Código de saída: 0 ok · 1 falha · 2 uso incorreto. Guia: docs/obsidian.md.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const MARKER = '.espectro-vault.json';
const MAX_BYTES = 300 * 1024;
const LINEAR = 'https://linear.app/prisma-app/issue/';
const SECRET = /-----BEGIN [A-Z ]*PRIVATE KEY( BLOCK)?-----|(?<![A-Za-z0-9])(?:api[_-]?key|secret|token|passw(?:or)?d)[A-Za-z0-9_]*["']?\s*[:=]\s*["']?[A-Za-z0-9_\-/+=]{16,}|\b(?:ghp_|sk-|AKIA)[A-Za-z0-9]{16,}/i;
const ORDEM = ['spec', 'tarefa', 'doc', 'skill', 'comando'];
const PASTA = { spec: 'Specs', tarefa: 'Tarefas', doc: 'Docs', skill: 'Skills', comando: 'Comandos' };
const TOKEN = /(!?\[[^\]\n]*\]\((?:<[^>]+>|[^)\s]+)(?:\s+"[^"]*")?\))|(\[\[[^\]]*\]\])|(https?:\/\/[^\s)>\]]+)|`([^`\n]+)`|\b(PRI-\d+)\b|(?<![\w./-])((?:docs|tasks|\.agents|\.claude|provenance)\/[\w./-]*\w\.md|(?:SPEC|README|AGENTS|CLAUDE)\.md)\b/g;

class UsageError extends Error {}
const inside = (base, p) => { const r = path.relative(base, p); return r === '' || (r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r)); };
// realpath do ancestral existente mais próximo (a pasta pode ainda não existir).
const real = (p) => {
    const rest = [];
    let cur = path.resolve(p);
    while (!fs.existsSync(cur)) { rest.unshift(path.basename(cur)); cur = path.dirname(cur); }
    return path.join(fs.realpathSync(cur), ...rest);
};
const clean = (s) => s.replace(/[#^[\]|\\/:?*"<>]/g, '').replace(/\./g, '-');
const sep = (parts) => parts.join(' › ');
const numero = (id) => Number(id.slice(4));

// Caminho rastreado → [tipo, nome da nota] ou null (fora do escopo do vault).
function classify(p) {
    let m;
    const noExt = p.replace(/\.md$/, '');
    if (p === 'SPEC.md') return ['spec', 'Spec · raiz'];
    if ((m = /^tasks\/([^/]+)\/(.+)\.md$/.exec(p))) {
        if (/^SPEC[^/]*$/.test(m[2])) return ['spec', `Spec · ${m[1]}${m[2] === 'SPEC' ? '' : ` · ${m[2]}`}`];
        return ['tarefa', `Tarefa · ${m[1]} · ${sep(m[2].split('/'))}`];
    }
    if ((m = /^\.agents\/skills\/([^/]+)\/SKILL\.md$/.exec(p))) return ['skill', `Skill · ${m[1]}`];
    if ((m = /^\.claude\/commands\/([^/]+)\.md$/.exec(p))) return ['comando', `Comando · ${m[1]}`];
    if (/^docs\/.+\.md$/.test(p)) return ['doc', `Doc · ${sep(noExt.slice(5).split('/'))}`];
    if (/^(README|AGENTS|CLAUDE)\.md$/.test(p)) return ['doc', `Doc · ${noExt}`];
    if (/^(\.agents\/(playbook|reference)\/.+|\.agents\/README|\.graph\/README|provenance\/.+)\.md$/.test(p)) {
        return ['doc', `Doc · ${sep(noExt.replace(/^\./, '').split('/'))}`];
    }
    return null;
}

const quote = (v) => JSON.stringify(v);
const yaml = (o) => `---\n${Object.entries(o).filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.map(quote).join(', ')}]` : quote(v)}`).join('\n')}\n---\n`;

// Troca referências por wikilinks fora de blocos de código e de links existentes.
// Referência PRI-n e caminho de nota conhecido viram [[nota]]; título de seção fica intacto.
function linkify(body, srcDir, names) {
    const find = (target) => {
        let t;
        try { t = decodeURI(target.split(/[#?]/)[0]); } catch { return undefined; }
        return [path.posix.normalize(path.posix.join(srcDir, t)), t.replace(/^\.\//, '')].map((c) => names.get(c)).find(Boolean);
    };
    let fence = null;
    return body.split('\n').map((line) => {
        const f = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
        if (f) {
            if (!fence) fence = { c: f[1][0], n: f[1].length };
            else if (f[1][0] === fence.c && f[1].length >= fence.n && !f[2].trim()) fence = null;
            return line;
        }
        if (fence || /^#{1,6}\s/.test(line) || /^\s*\[[^\]]+\]:\s/.test(line)) return line;
        const bar = line.trimStart().startsWith('|') ? '\\|' : '|';
        const link = (n, label) => `[[${n}${bar}${label}]]`;
        return line.replace(TOKEN, (m, md, wiki, url, code, issue, bare) => {
            if (wiki || url) return m;
            if (md) {
                const mm = /^(!?)\[([^\]]*)\]\(([^)\s<>]+)\)$/.exec(md);
                const n = mm && !mm[1] && !/^[a-z][a-z0-9+.-]*:/i.test(mm[3]) && find(mm[3]);
                return n ? link(n, mm[2]) : md;
            }
            if (issue) return `[[${issue}]]`;
            const ref = (code ?? bare).trim();
            const n = names.get(ref.includes('/') ? ref : path.posix.join(srcDir, ref));
            return n ? link(n, code ?? bare) : m;
        });
    }).join('\n');
}

function git(repo, args) {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 28 });
}

function lastDates(repo) {
    const dates = new Map();
    let day = '';
    for (const line of git(repo, ['-c', 'core.quotepath=off', 'log', '--no-renames', '--format=%x00%cs', '--name-only']).split('\n')) {
        if (line.startsWith('\0')) day = line.slice(1);
        else if (line && !dates.has(line)) dates.set(line, day);
    }
    return dates;
}

// Monta o vault em memória: Map<caminho relativo, conteúdo>. Não toca o disco.
function buildVault(repo) {
    const sha = git(repo, ['rev-parse', '--short', 'HEAD']).trim() + (git(repo, ['status', '--porcelain', '--untracked-files=no']).trim() ? '+local' : '');
    const dates = lastDates(repo);
    const tracked = git(repo, ['ls-files', '-z']).split('\0').filter(Boolean);
    const arquivo = (p) => fs.lstatSync(path.join(repo, p), { throwIfNoEntry: false })?.isFile();
    const read = (p) => (tracked.includes(p) && arquivo(p) ? fs.readFileSync(path.join(repo, p), 'utf8') : '');
    const notes = [], skipped = [], names = new Map(), used = new Set();
    for (const p of tracked) {
        const c = classify(p);
        if (!c) continue;
        if (!arquivo(p)) continue;
        const raw = fs.readFileSync(path.join(repo, p), 'utf8');
        if (raw.length > MAX_BYTES || SECRET.test(raw)) { skipped.push(`${p} (${raw.length > MAX_BYTES ? 'grande' : 'possível segredo'})`); continue; }
        let name = clean(c[1]);
        for (let i = 2; used.has(name.toLowerCase()); i += 1) name = `${clean(c[1])} (${i})`;
        used.add(name.toLowerCase());
        names.set(p, name);
        notes.push({ p, tipo: c[0], name, raw });
    }
    const files = new Map(), citedBy = new Map(), together = new Map();
    for (const n of notes) {
        const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(n.raw);
        const body = fm ? n.raw.slice(fm[0].length) : n.raw;
        n.ids = [...new Set(n.raw.match(/\bPRI-\d+\b/g) ?? [])].sort((a, b) => numero(a) - numero(b));
        n.titulo = /^# (.+)$/m.exec(body)?.[1].trim();
        const d = fm && /^description:[ \t]*(.*)((?:\r?\n[ \t]+.*)*)/m.exec(fm[1]);
        n.desc = (d && (/^[>|][+-]?$/.test(d[1]) ? d[2] : d[1]).trim().replace(/\s*\r?\n\s*/g, ' ').replace(/^["']|["']$/g, '')) || undefined;
        for (const id of n.ids) {
            citedBy.set(id, [...(citedBy.get(id) ?? []), n]);
            for (const o of n.ids) if (o !== id) together.set(`${id} ${o}`, (together.get(`${id} ${o}`) ?? 0) + 1);
        }
        files.set(`${PASTA[n.tipo]}/${n.name}.md`, yaml({
            tipo: n.tipo, titulo: n.titulo, descricao: n.desc, origem: n.p, commit: sha, atualizado: dates.get(n.p),
            issues: n.ids.map((i) => `[[${i}]]`), tags: [`espectro/${n.tipo}`],
        }) + `\n> [!warning] Projeção somente leitura\n> Fonte de verdade: \`${n.p}\` @ \`${sha}\`. Edições aqui não voltam ao repositório e se perdem na próxima exportação.\n\n`
            + linkify(body, path.posix.dirname(n.p), names));
    }
    const ids = [...citedBy.keys()].sort((a, b) => numero(b) - numero(a));
    for (const id of ids) {
        const por = (t) => citedBy.get(id).filter((n) => n.tipo === t).map((n) => `- [[${n.name}]]`);
        const rel = [...together].filter(([k]) => k.startsWith(`${id} `)).map(([k, v]) => [k.slice(id.length + 1), v])
            .sort((a, b) => b[1] - a[1] || numero(a[0]) - numero(b[0])).slice(0, 8);
        files.set(`Issues/${id}.md`, yaml({ tipo: 'issue', linear: LINEAR + id, citacoes: citedBy.get(id).length, tags: ['espectro/issue'] })
            + `\n# ${id}\n\n> [!info] Nota de ligação\n> Título e estado vivem no Linear: [${id}](${LINEAR}${id}). Aqui só aparece quem cita esta issue.\n`
            + ORDEM.flatMap((t) => (por(t).length ? [`\n## Citada em: ${PASTA[t]}\n`, ...por(t)] : [])).join('\n') + '\n'
            + (rel.length ? `\n## Relacionadas\n\n${rel.map(([o, v]) => `- [[${o}]] (${v} em comum)`).join('\n')}\n` : ''));
    }
    const moc = (nome, intro, corpo, extra = {}) => files.set(`${nome}.md`,
        `${yaml({ tipo: 'indice', tags: ['espectro/indice'], ...extra })}\n${intro}\n\n${corpo}\n`);
    const item = (n) => `- [[${n.name}]]${n.titulo ? ` — ${n.titulo}` : ''}`;
    const de = (t) => notes.filter((n) => n.tipo === t).sort((a, b) => a.name.localeCompare(b.name, 'pt'));
    const base = (tipo, ordem) => `filters:\n  and:\n    - 'tipo == "${tipo}"'\nviews:\n  - type: table\n    name: ${tipo}\n    order:\n${ordem.map((o) => `      - ${o}`).join('\n')}\n`;
    files.set('Painéis/Specs.base', base('spec', ['file.name', 'note.atualizado', 'note.issues']));
    files.set('Painéis/Issues.base', base('issue', ['file.name', 'note.citacoes', 'note.linear']));
    moc('01 Specs', 'O que cada fatia promete entregar. Cada spec liga às issues que cita.', `${de('spec').map(item).join('\n')}\n\n## Tabela\n\n![[Specs.base]]`);
    moc('02 Issues', 'Entidades de ligação: abra uma issue para ver tudo que a cita.', `${ids.map((i) => `- [[${i}]] (${citedBy.get(i).length})`).join('\n')}\n\n## Tabela\n\n![[Issues.base]]`);
    const grupo = (n) => path.posix.dirname(n.p).replace(/^\.\/?/, '') || 'raiz';
    moc('03 Docs', 'Documentação permanente, agrupada pela pasta de origem.', [...new Set(de('doc').map(grupo))].map((g) => `## ${g}\n\n${de('doc').filter((n) => grupo(n) === g).map(item).join('\n')}`).join('\n\n'));
    moc('04 Skills', 'Skills de produção do repositório.', de('skill').map((n) => `- [[${n.name}]]${n.desc ? ` — ${n.desc.slice(0, 140)}` : ''}`).join('\n'));
    const fluxo = read('.graph/graph.yaml').split(/^ {2}- id: /m).slice(1).map((c) => ({
        id: /^\w+/.exec(c)[0], cmd: /command: \/(\S+)/.exec(c)?.[1], next: /on_success: (\w+)/.exec(c)?.[1] }));
    moc('05 Comandos e fluxo', 'Nós do grafo de execução (`.graph/graph.yaml`) e o comando de cada um.',
        `${fluxo.map((f) => `- ${f.cmd && names.has(`.claude/commands/${f.cmd}.md`) ? `[[${names.get(`.claude/commands/${f.cmd}.md`)}]]` : f.id}${f.next ? ` → \`${f.next}\`` : ''}`).join('\n')}\n\n## Demais comandos\n\n${de('comando').map(item).join('\n')}`);
    const tasks = [...new Set(de('tarefa').map((n) => n.name.split(' · ')[1]))];
    moc('06 Tarefas', 'Planos e listas por tarefa. As specs ficam em 01 Specs.', tasks.map((t) => `## ${t}\n\n${de('tarefa').filter((n) => n.name.split(' · ')[1] === t).map(item).join('\n')}`).join('\n\n'));
    const mods = [...read('ownership.yaml').matchAll(/- path: (\S+)\n\s+capability: (\S+)\n\s+owner: (\S+)/g)];
    moc('07 Módulos', 'Módulo → capacidade → owner lógico (`ownership.yaml`). UNKNOWN permanece UNKNOWN.', `| Módulo | Capacidade | Owner |\n| -- | -- | -- |\n${mods.map((m) => `| \`${m[1]}\` | ${m[2]} | ${m[3]} |`).join('\n')}`);
    moc('00 Início', `Projeção somente leitura do repositório do Espectro (commit \`${sha}\`). A fonte de verdade é o Git; o estado operacional é o Linear.`,
        `## Por onde começar\n\n- [[01 Specs]] · [[02 Issues]] · [[03 Docs]] · [[04 Skills]] · [[05 Comandos e fluxo]] · [[06 Tarefas]] · [[07 Módulos]]\n\n## Como navegar\n\n- Comece numa spec e siga as issues citadas; em cada issue, os painéis de backlinks mostram quem mais a cita.\n- Graph view: filtre por \`tag:#espectro/spec\` (ou \`doc\`, \`issue\`, \`skill\`) e use grupos por tag para colorir.\n- Cada nota traz a origem e o commit nas propriedades. Não edite aqui: a próxima exportação apaga.\n\n${notes.length} notas, ${ids.length} issues citadas.`);
    return { files, skipped, sha, count: notes.length };
}

// Escreve o vault. Só mexe em pasta vazia ou em vault gerado por este comando (marcador).
function writeVault(outDir, repoDir, vault) {
    const out = real(outDir);
    if (inside(real(repoDir), out)) throw new UsageError('--out não pode ficar dentro do repositório');
    const marker = path.join(out, MARKER);
    const vazio = !fs.existsSync(out) || !fs.readdirSync(out).filter((f) => !['.obsidian', '.DS_Store'].includes(f)).length;
    if (!vazio && !fs.existsSync(marker)) throw new UsageError(`${out} não está vazia nem é um vault gerado por este comando (falta ${MARKER})`);
    // Todo caminho é validado antes de apagar ou gravar: nada sai de `out`, nem por symlink.
    const safe = (f) => {
        const t = typeof f === 'string' ? path.resolve(out, f) : '';
        if (!t || !inside(out, t) || !inside(out, real(path.dirname(t))) || fs.lstatSync(t, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`caminho inválido no vault: ${f}`);
        return t;
    };
    const antigos = fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker, 'utf8')).arquivos : [];
    if (!Array.isArray(antigos)) throw new Error('marcador inválido');
    const nomes = [...vault.files.keys()].sort();
    const apagar = antigos.map(safe);
    const gravar = nomes.map((f) => [safe(f), f]);
    for (const t of apagar) fs.rmSync(t, { force: true });
    for (const [t, f] of gravar) {
        fs.mkdirSync(path.dirname(t), { recursive: true });
        fs.writeFileSync(t, vault.files.get(f));
    }
    fs.writeFileSync(marker, `${JSON.stringify({ versao: 1, commit: vault.sha, arquivos: nomes }, null, 2)}\n`);
}

function main(argv) {
    const arg = (k) => { const v = argv[argv.indexOf(k) + 1]; return argv.includes(k) && v && !v.startsWith('--') ? v : undefined; };
    try {
        if (!arg('--out')) throw new UsageError('uso: obsidian-export.js --out <pasta-do-vault> [--repo <raiz>]');
        const repo = fs.realpathSync(path.resolve(arg('--repo') ?? path.join(__dirname, '..')));
        const vault = buildVault(repo);
        writeVault(path.resolve(arg('--out')), repo, vault);
        console.log(`vault: ${vault.count} notas em ${path.resolve(arg('--out'))} (commit ${vault.sha})`);
        for (const s of vault.skipped) console.log(`ignorado: ${s}`);
    } catch (err) {
        console.error(`[obsidian-export] ${err.message}`);
        process.exitCode = err instanceof UsageError ? 2 : 1;
    }
}

module.exports = { buildVault, writeVault, classify, linkify, UsageError };
if (require.main === module) main(process.argv.slice(2));
