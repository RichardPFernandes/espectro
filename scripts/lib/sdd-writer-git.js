'use strict';
// Writer SDD (PRI-266) — acesso Git por objeto (C-03): nunca lê working tree.
// Leitura: rev-parse, ls-tree, cat-file, diff-tree, rev-list, merge-base, for-each-ref.
// Escrita (só W-P e host simulado): hash-object, mktree, commit-tree. Nenhuma ref é
// movida aqui: refs são do host (HP-3/HP-4).
// Falha de execução do git = falha de OBTENÇÃO → UnverifiableError (C-11, R4-01).

const { spawnSync } = require('node:child_process');

class UnverifiableError extends Error {
    constructor(reason, message) {
        super(message || reason);
        this.name = 'UnverifiableError';
        this.reason = reason;
    }
}

const NUL = '\0';
const STDIN_ATTEMPTS = 4;
const STDIN_TIMEOUT_MS = 3000;

function makeGit(repoDir, { identity } = {}) {
    const baseEnv = {
        PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C',
    };
    function run(args, { input, allow = [0], env } = {}) {
        // Medido nesta máquina (git 2.52, macOS, também com config isolada): ~1% das chamadas
        // que leem stdin não terminam; `cat`/`shasum` no mesmo laço não travam. Causa: UNKNOWN.
        // Só hash-object/mktree/commit-tree leem stdin. Repetir não move ref: blob e árvore são
        // endereçados por conteúdo; commit-tree é determinístico quando o W-P fixa as datas
        // (`at`); sem data fixa, a tentativa morta deixa só um objeto órfão. Timeout cresce com
        // o tamanho da entrada. Esgotado o limite → falha de obtenção (UNVERIFIABLE).
        const attempts = input === undefined ? 1 : STDIN_ATTEMPTS;
        let r;
        for (let i = 0; i < attempts; i++) {
            r = spawnSync('git', ['-C', repoDir, ...args], {
                input, env: { ...baseEnv, ...env }, maxBuffer: 512 * 1024 * 1024,
                // Sem entrada explícita, o git nunca herda nem espera stdin.
                stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
                timeout: input === undefined ? undefined : STDIN_TIMEOUT_MS + Math.ceil(Buffer.byteLength(input) / 65536) * 100,
            });
            if (!(r.error && r.error.code === 'ETIMEDOUT') && r.signal === null) break;
        }
        if (r.error && r.error.code === 'ETIMEDOUT') throw new UnverifiableError('GIT_TIMEOUT', `git ${args[0]} sem resposta`);
        if (r.error) throw new UnverifiableError('GIT_SPAWN', r.error.message);
        if (!allow.includes(r.status)) {
            throw new UnverifiableError('GIT', `git ${args[0]} saiu ${r.status}: ${String(r.stderr).trim().slice(0, 300)}`);
        }
        return { status: r.status, stdout: r.stdout };
    }
    const out = (args, opts) => run(args, opts).stdout.toString('utf8').trim();

    let emptyTree = null;
    const api = {
        repoDir,
        /** sha do commit ou null se não existe (erro ≠ inexistente). */
        resolveCommit(rev) {
            const r = run(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { allow: [0, 1] });
            return r.status === 0 ? r.stdout.toString().trim() : null;
        },
        treeOf(commit) { return out(['rev-parse', '--verify', `${commit}^{tree}`]); },
        firstParent(commit) {
            const r = run(['rev-parse', '--verify', '--quiet', `${commit}^1`], { allow: [0, 1] });
            return r.status === 0 ? r.stdout.toString().trim() : null;
        },
        emptyTree() {
            if (!emptyTree) emptyTree = out(['mktree'], { input: '' });
            return emptyTree;
        },
        /** Entrada da árvore em `path` ou null. */
        entry(treeish, p) {
            const r = run(['ls-tree', '-z', '--full-tree', treeish, '--', p]).stdout.toString('utf8');
            if (!r) return null;
            const rec = r.split(NUL).filter(Boolean).find(x => x.split('\t')[1] === p);
            if (!rec) return null;
            const [meta, name] = rec.split('\t');
            const [mode, type, oid] = meta.split(' ');
            return { mode, type, oid, path: name };
        },
        /** Bytes do blob em `path`, ou null se ausente. Árvore/symlink no lugar de arquivo → erro de conteúdo. */
        readBlob(treeish, p) {
            const e = api.entry(treeish, p);
            if (!e) return null;
            if (e.type !== 'blob' || (e.mode !== '100644' && e.mode !== '100755')) {
                const err = new Error(`${p}: não é arquivo regular (${e.mode} ${e.type})`);
                err.code = 'NOT_REGULAR_FILE';
                throw err;
            }
            return run(['cat-file', 'blob', e.oid]).stdout;
        },
        /** Todos os arquivos sob `prefix` (recursivo): Map path → {mode, type, oid}. */
        listFiles(treeish, prefix) {
            const r = run(['ls-tree', '-r', '-z', '--full-tree', treeish, '--', prefix]).stdout.toString('utf8');
            const m = new Map();
            for (const rec of r.split(NUL).filter(Boolean)) {
                const [meta, name] = rec.split('\t');
                const [mode, type, oid] = meta.split(' ');
                if (name === prefix || name.startsWith(`${prefix}/`)) m.set(name, { mode, type, oid });
            }
            return m;
        },
        /** Diff de nomes entre dois tree-ish (sem detecção de rename). */
        diff(a, b) {
            const r = run(['diff-tree', '-r', '-z', '--no-renames', '--name-status', a, b]).stdout.toString('utf8');
            const parts = r.split(NUL).filter(x => x !== '');
            const res = [];
            for (let i = 0; i + 1 < parts.length; i += 2) res.push({ status: parts[i], path: parts[i + 1] });
            return res;
        },
        isAncestor(a, b) {
            const r = run(['merge-base', '--is-ancestor', a, b], { allow: [0, 1] });
            return r.status === 0;
        },
        /** Cadeia de primeiro pai, da gênese até `tip`. */
        firstParentChain(tip) {
            const s = out(['rev-list', '--first-parent', '--reverse', tip]);
            return s ? s.split('\n') : [];
        },
        /** Algum ancestral de `tip` contém/alterou `p`? (C-17) */
        everInHistory(tip, p) {
            return out(['rev-list', '-1', '--full-history', tip, '--', p]) !== '';
        },
        commitMessage(commit) { return out(['log', '-1', '--format=%B', commit]); },
        commitAuthor(commit) { return out(['log', '-1', '--format=%an', commit]); },
        listRefs(prefix) {
            const s = out(['for-each-ref', '--format=%(refname) %(objectname)', prefix]);
            return s ? s.split('\n').map(l => { const [name, oid] = l.split(' '); return { name, oid }; }) : [];
        },
        // ---- escrita de objetos (sem mover ref) ----
        hashBlob(buf) {
            if (!Buffer.isBuffer(buf)) throw new TypeError('hashBlob: conteúdo deve ser Buffer');
            return out(['hash-object', '-w', '--stdin'], { input: buf });
        },
        /** Nova árvore = `baseTreeish` + `changes` {path: Buffer|null(remove)}. */
        buildTree(baseTreeish, changes) {
            const files = new Map();
            if (baseTreeish) {
                const all = run(['ls-tree', '-r', '-z', '--full-tree', baseTreeish]).stdout.toString('utf8');
                for (const rec of all.split(NUL).filter(Boolean)) {
                    const [meta, name] = rec.split('\t');
                    const [mode, type, oid] = meta.split(' ');
                    files.set(name, { mode, type, oid });
                }
            }
            for (const [p, buf] of Object.entries(changes)) {
                if (buf === null) files.delete(p);
                else files.set(p, { mode: files.has(p) && files.get(p).mode === '100755' ? '100755' : '100644', type: 'blob', oid: api.hashBlob(buf) });
            }
            const root = { files: new Map(), dirs: new Map() };
            for (const [p, e] of files) {
                const segs = p.split('/');
                let node = root;
                for (const s of segs.slice(0, -1)) {
                    if (!node.dirs.has(s)) node.dirs.set(s, { files: new Map(), dirs: new Map() });
                    node = node.dirs.get(s);
                }
                node.files.set(segs[segs.length - 1], e);
            }
            const write = node => {
                const lines = [];
                for (const [name, sub] of node.dirs) lines.push(`040000 tree ${write(sub)}\t${name}`);
                for (const [name, e] of node.files) lines.push(`${e.mode} ${e.type} ${e.oid}\t${name}`);
                return out(['mktree', '-z'], { input: lines.map(l => l + NUL).join('') });
            };
            return write(root);
        },
        commitTree(tree, parents, message, who = identity, { date } = {}) {
            if (!who) throw new Error('commitTree: identidade obrigatória');
            const env = {
                GIT_AUTHOR_NAME: who, GIT_AUTHOR_EMAIL: `${who}@sdd.invalid`,
                GIT_COMMITTER_NAME: who, GIT_COMMITTER_EMAIL: `${who}@sdd.invalid`,
                ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
            };
            const args = ['commit-tree', tree, ...parents.flatMap(p => ['-p', p])];
            return out(args, { input: message, env });
        },
        run,
    };
    return api;
}

/** Leitor de árvore usado pela função de decisão. `id` é o tree-ish. */
function treeReader(git, treeish) {
    return {
        id: treeish,
        read: p => git.readBlob(treeish, p),
        list: prefix => git.listFiles(treeish, prefix),
    };
}

/** Árvore em memória (testes puros): {path: Buffer|string}. */
function memTree(files, id = 'mem') {
    const m = new Map(Object.entries(files).map(([k, v]) => [k, Buffer.isBuffer(v) ? v : Buffer.from(v, 'utf8')]));
    return {
        id,
        read: p => (m.has(p) ? m.get(p) : null),
        list: prefix => new Map([...m.keys()].filter(k => k === prefix || k.startsWith(`${prefix}/`)).map(k => [k, { mode: '100644', type: 'blob', oid: null }])),
    };
}

module.exports = { makeGit, treeReader, memTree, UnverifiableError };
