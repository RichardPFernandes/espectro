#!/usr/bin/env node
// PRI-391 (F2.2/F2.3): Redmine local do piloto no próprio Espectro.
//
// STATUS: ferramenta offline do piloto. Não roda numa Run, não é adapter de tracker e não entra
// no watcher: o watcher e o MCP `redmine` do agente continuam falando REST com um Redmine; no
// piloto, esse Redmine é este servidor, só em loopback.
//
// Por que existe: o watcher lista tudo o que está atribuído à chave (`assigned_to_id=me`), sem
// filtro de projeto, e o MCP `redmine` do perfil aponta para o Redmine corporativo. Apontar o
// piloto para lá traria tickets alheios para o repo do Espectro. Aqui os tickets moram num JSON.
//
// Responde só ao subconjunto da API REST do Redmine que o watcher e o MCP usam:
//   GET /issues.json            filtros status_id (lista "a|b", "open", "closed", "*"),
//                               assigned_to_id=me; offset/limit
//   GET /issues/:id.json        include=journals,attachments (vírgula ou include[]=)
//   PUT /issues/:id.json        { issue: { notes, status_id, assigned_to_id, done_ratio,
//                               custom_fields } } → journal novo, 204
//   GET /users/current.json, GET /issue_statuses.json
// Qualquer outra rota responde 404 e vai para o log como UNHANDLED: chamada desconhecida não
// vira sucesso silencioso.
//
// Uso:
//   node scripts/probes/pilot-redmine.js serve --store <tickets.json> --key <chave> \
//        [--port 3380] [--log <requests.jsonl>]
//   node scripts/probes/pilot-redmine.js seed --store <tickets.json> --from <novos.json>
//     novos.json: [ { "id": 9001, "subject": "...", "description": "...",
//                     "tracker": "Tarefa", "custom_fields": [...] } ]  (status inicial: Aprovada)
// A chave é do piloto, não um segredo corporativo; mesmo assim nunca vai para o log.

'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const HOST = '127.0.0.1';
const DEFAULT_PORT = 3380;
const MAX_BODY = 1024 * 1024;
const USER = { id: 1, name: 'Piloto Espectro', login: 'piloto' };
// Ids iguais aos que o watcher e os comandos usam (STATUS_IDS no watcher, fetch-ticket e commit).
const STATUSES = [
    { id: 2, name: 'Em Desenvolvimento', is_closed: false },
    { id: 3, name: 'Ag Teste', is_closed: false },
    { id: 5, name: 'Fechada', is_closed: true },
    { id: 11, name: 'Aprovada', is_closed: false },
    { id: 13, name: 'Recusa QA', is_closed: false },
    { id: 20, name: 'Ag Merge', is_closed: false },
];
const STATUS_BY_ID = new Map(STATUSES.map(s => [s.id, s]));
const INITIAL_STATUS = 11;

function nowIso() { return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'); }

function emptyStore() { return { next_journal_id: 1, issues: [] }; }

function loadStore(file) {
    if (!fs.existsSync(file)) return emptyStore();
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || !Array.isArray(data.issues) || !Number.isInteger(data.next_journal_id)) {
        throw new Error(`store inválido: ${file}`);
    }
    return data;
}

// Escrita atômica: um crash no meio nunca deixa o JSON pela metade.
function saveStore(file, store) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
    fs.renameSync(tmp, file);
}

function statusRef(id) {
    const s = STATUS_BY_ID.get(id);
    return s ? { id: s.id, name: s.name, is_closed: s.is_closed } : { id, name: 'UNKNOWN' };
}

function normalizeSeed(t, now) {
    if (!Number.isInteger(t.id) || t.id <= 0) throw new Error(`ticket sem id inteiro: ${JSON.stringify(t).slice(0, 80)}`);
    if (typeof t.subject !== 'string' || !t.subject.trim()) throw new Error(`ticket #${t.id} sem subject`);
    return {
        id: t.id,
        project: { id: 1, name: 'Espectro (piloto)' },
        tracker: { id: 1, name: t.tracker || 'Tarefa' },
        status: statusRef(INITIAL_STATUS),
        priority: { id: 2, name: 'Normal' },
        author: { ...USER },
        assigned_to: { id: USER.id, name: USER.name },
        subject: t.subject,
        description: t.description || '',
        done_ratio: 0,
        custom_fields: Array.isArray(t.custom_fields) ? t.custom_fields : [],
        created_on: t.created_on || now,
        updated_on: t.created_on || now,
        journals: [],
        attachments: [],
    };
}

function seed(storeFile, fromFile) {
    const store = loadStore(storeFile);
    const incoming = JSON.parse(fs.readFileSync(fromFile, 'utf8'));
    if (!Array.isArray(incoming)) throw new Error('--from precisa ser uma lista de tickets');
    const ids = new Set(store.issues.map(i => i.id));
    const now = nowIso();
    let added = 0;
    for (const t of incoming) {
        const issue = normalizeSeed(t, now);
        if (ids.has(issue.id)) throw new Error(`ticket #${issue.id} já existe no store`);
        ids.add(issue.id);
        store.issues.push(issue);
        added++;
    }
    saveStore(storeFile, store);
    return added;
}

function includes(url) {
    const out = new Set();
    for (const v of url.searchParams.getAll('include')) v.split(',').forEach(x => x && out.add(x.trim()));
    for (const v of url.searchParams.getAll('include[]')) out.add(v.trim());
    return out;
}

function view(issue, inc) {
    const { journals, attachments, ...rest } = issue;
    const out = { ...rest };
    if (inc.has('journals')) out.journals = journals;
    if (inc.has('attachments')) out.attachments = attachments;
    return out;
}

function matchesStatus(issue, filter) {
    if (!filter || filter === 'open') return !issue.status.is_closed;
    if (filter === '*') return true;
    if (filter === 'closed') return !!issue.status.is_closed;
    return filter.split('|').map(Number).includes(issue.status.id);
}

function listIssues(store, url) {
    const assigned = url.searchParams.get('assigned_to_id');
    let issues = store.issues.filter(i => matchesStatus(i, url.searchParams.get('status_id')));
    if (assigned && assigned !== 'me' && Number(assigned) !== USER.id) issues = [];
    issues.sort((a, b) => (b.created_on.localeCompare(a.created_on)) || (b.id - a.id));
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 25));
    return {
        issues: issues.slice(offset, offset + limit).map(i => view(i, new Set())),
        total_count: issues.length, offset, limit,
    };
}

// Aplica um PUT como o Redmine: cada mudança vira um journal, com `details` por campo.
function applyUpdate(store, issue, patch) {
    const details = [];
    if (patch.status_id !== undefined) {
        const id = Number(patch.status_id);
        if (!STATUS_BY_ID.has(id)) return { error: `status_id desconhecido: ${patch.status_id}` };
        if (id !== issue.status.id) {
            details.push({ property: 'attr', name: 'status_id', old_value: String(issue.status.id), new_value: String(id) });
            issue.status = statusRef(id);
        }
    }
    if (patch.done_ratio !== undefined) {
        details.push({ property: 'attr', name: 'done_ratio', old_value: String(issue.done_ratio), new_value: String(patch.done_ratio) });
        issue.done_ratio = Number(patch.done_ratio);
    }
    if (patch.assigned_to_id !== undefined && Number(patch.assigned_to_id) !== USER.id) {
        return { error: 'o piloto tem um único usuário; assigned_to_id diferente é recusado' };
    }
    if (Array.isArray(patch.custom_fields)) {
        for (const cf of patch.custom_fields) {
            const cur = issue.custom_fields.find(f => f.id === cf.id || (cf.name && f.name === cf.name));
            if (cur) cur.value = cf.value; else issue.custom_fields.push({ id: cf.id, name: cf.name || `cf_${cf.id}`, value: cf.value });
            details.push({ property: 'cf', name: String(cf.id ?? cf.name), new_value: String(cf.value) });
        }
    }
    const notes = typeof patch.notes === 'string' ? patch.notes : '';
    if (!notes && !details.length) return { changed: false };
    const now = nowIso();
    issue.journals.push({ id: store.next_journal_id++, user: { id: USER.id, name: USER.name }, notes, created_on: now, details });
    issue.updated_on = now;
    return { changed: true };
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0; const chunks = [];
        req.on('data', c => {
            size += c.length;
            if (size > MAX_BODY) { reject(Object.assign(new Error('corpo grande demais'), { status: 413 })); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function createServer({ store: storeFile, key, log }) {
    if (!key) throw new Error('--key é obrigatório');
    const writeLog = entry => {
        if (!log) return;
        try { fs.appendFileSync(log, JSON.stringify({ ts: nowIso(), ...entry }) + '\n'); } catch { /* log é auxílio, não estado */ }
    };
    // Um request por vez sobre o store: leitura e escrita nunca se cruzam.
    let chain = Promise.resolve();
    const serial = fn => (chain = chain.then(fn, fn));

    return http.createServer((req, res) => serial(async () => {
        const url = new URL(req.url, `http://${HOST}`);
        const send = (status, body, handled = true) => {
            writeLog({ method: req.method, path: url.pathname, query: url.search, status, handled });
            if (body === undefined) { res.writeHead(status); res.end(); return; }
            res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(body));
        };
        try {
            if (req.headers['x-redmine-api-key'] !== key) return send(401, { errors: ['chave inválida'] });
            const store = loadStore(storeFile);
            if (req.method === 'GET' && url.pathname === '/issues.json') return send(200, listIssues(store, url));
            if (req.method === 'GET' && url.pathname === '/users/current.json') return send(200, { user: { ...USER } });
            if (req.method === 'GET' && url.pathname === '/issue_statuses.json') return send(200, { issue_statuses: STATUSES });
            const m = url.pathname.match(/^\/issues\/(\d+)\.json$/);
            if (m) {
                const issue = store.issues.find(i => i.id === Number(m[1]));
                if (!issue) return send(404, { errors: ['ticket não existe'] });
                if (req.method === 'GET') return send(200, { issue: view(issue, includes(url)) });
                if (req.method === 'PUT') {
                    let body;
                    try { body = JSON.parse(await readBody(req) || '{}'); } catch (e) {
                        if (e.status) return send(e.status, { errors: [e.message] });
                        return send(400, { errors: ['JSON inválido'] });
                    }
                    const r = applyUpdate(store, issue, (body && body.issue) || {});
                    if (r.error) return send(422, { errors: [r.error] });
                    if (r.changed) saveStore(storeFile, store);
                    return send(204);
                }
            }
            return send(404, { errors: ['rota não suportada pelo Redmine local'] }, false);
        } catch (e) {
            return send(500, { errors: [e.message] });
        }
    }));
}

function parseArgs(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) out[a.slice(2)] = argv[++i]; else out._.push(a);
    }
    return out;
}

function main(argv) {
    const args = parseArgs(argv);
    const cmd = args._[0];
    if (!args.store) throw new Error('--store é obrigatório');
    const store = path.resolve(args.store);
    if (cmd === 'seed') {
        if (!args.from) throw new Error('--from é obrigatório');
        console.log(`seed: ${seed(store, path.resolve(args.from))} ticket(s) em ${store}`);
        return null;
    }
    if (cmd === 'serve') {
        const port = args.port ? Number(args.port) : DEFAULT_PORT;
        if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port inválida: ${args.port}`);
        const server = createServer({ store, key: args.key, log: args.log && path.resolve(args.log) });
        server.listen(port, HOST, () => console.log(`Redmine local do piloto em http://${HOST}:${server.address().port} (store ${store})`));
        return server;
    }
    throw new Error('uso: pilot-redmine.js serve|seed --store <arquivo> ...');
}

module.exports = { createServer, seed, loadStore, listIssues, applyUpdate, STATUSES, HOST, USER };

if (require.main === module) {
    try { main(process.argv.slice(2)); } catch (e) { console.error(`pilot-redmine: ${e.message}`); process.exit(2); }
}
