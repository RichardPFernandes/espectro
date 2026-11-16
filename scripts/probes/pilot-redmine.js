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
// Fora disso nada vira sucesso silencioso: rota desconhecida responde 404, e filtro, parâmetro
// ou campo de PUT fora do subconjunto responde 422. Todos ficam no log com handled: false.
//
// Uso:
//   node scripts/probes/pilot-redmine.js serve --store <tickets.json> --key <chave> \
//        [--port 3380] [--log <requests.jsonl>]
//   node scripts/probes/pilot-redmine.js seed --store <tickets.json> --from <novos.json>   (servidor parado)
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
// Ids iguais aos que o watcher e os comandos usam: STATUS_IDS (readmine-watcher.js:320),
// "Em Desenvolvimento" (fetch-ticket), "Ag Merge" (commit.md:188), "Ag Teste"
// (qa-handback.js:24). Status fora desta lista responde 422.
const STATUSES = [
    { id: 2, name: 'Em Desenvolvimento', is_closed: false },
    { id: 5, name: 'Fechada', is_closed: true },
    { id: 8, name: 'Ag Teste', is_closed: false },
    { id: 11, name: 'Aprovada', is_closed: false },
    { id: 13, name: 'Recusa QA', is_closed: false },
    { id: 20, name: 'Ag Merge', is_closed: false },
];
const STATUS_BY_ID = new Map(STATUSES.map(s => [s.id, s]));
const INITIAL_STATUS = 11;
// Campos que um PUT pode mudar; qualquer outro responde 422 e vai para o log como não tratado.
const PUT_FIELDS = new Set(['notes', 'status_id', 'assigned_to_id', 'done_ratio', 'custom_fields']);
// Parâmetros de GET /issues.json que o servidor aplica; outro filtro responde 422 (ignorá-lo
// devolveria a lista inteira como se tivesse filtrado).
const LIST_PARAMS = new Set(['assigned_to_id', 'status_id', 'sort', 'offset', 'limit', 'include', 'include[]']);
const ISSUE_PARAMS = new Set(['include', 'include[]']);

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
    if (!t || !Number.isInteger(t.id) || t.id <= 0) throw new Error(`ticket sem id inteiro: ${JSON.stringify(t).slice(0, 80)}`);
    if (typeof t.subject !== 'string' || !t.subject.trim()) throw new Error(`ticket #${t.id} sem subject`);
    if (t.description !== undefined && typeof t.description !== 'string') throw new Error(`ticket #${t.id}: description precisa ser texto`);
    if (t.created_on !== undefined && (typeof t.created_on !== 'string' || Number.isNaN(Date.parse(t.created_on)))) {
        throw new Error(`ticket #${t.id}: created_on precisa ser data ISO`);
    }
    if (t.custom_fields !== undefined) {
        if (!Array.isArray(t.custom_fields) || !t.custom_fields.every(f => f && Number.isInteger(f.id) && typeof f.name === 'string')) {
            throw new Error(`ticket #${t.id}: custom_fields precisa ser lista de { id inteiro, name, value }`);
        }
    }
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

const lockFile = storeFile => `${storeFile}.lock`;

// Seed só com o servidor parado: um PUT em voo regravaria o store sem os tickets novos.
function seed(storeFile, fromFile) {
    if (fs.existsSync(lockFile(storeFile))) {
        throw new Error(`servidor rodando sobre ${storeFile} (${lockFile(storeFile)}); pare-o antes do seed`);
    }
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
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { error: 'corpo precisa ser { issue: { ... } }', unhandled: true };
    const extra = Object.keys(patch).filter(k => !PUT_FIELDS.has(k));
    if (extra.length) return { error: `campo(s) fora do subconjunto do piloto: ${extra.join(', ')}`, unhandled: true };
    if (patch.notes !== undefined && typeof patch.notes !== 'string') return { error: 'notes precisa ser texto' };
    if (patch.done_ratio !== undefined) {
        const r = Number(patch.done_ratio);
        if (!Number.isInteger(r) || r < 0 || r > 100) return { error: `done_ratio inválido: ${patch.done_ratio}` };
    }
    if (patch.custom_fields !== undefined) {
        if (!Array.isArray(patch.custom_fields) || !patch.custom_fields.every(f => f && Number.isInteger(Number(f.id)) && f.value !== undefined)) {
            return { error: 'custom_fields precisa ser lista de { id, value }' };
        }
    }
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
        // Como o Redmine: o campo é identificado só pelo id (número ou texto numérico).
        for (const cf of patch.custom_fields) {
            const id = Number(cf.id);
            const cur = issue.custom_fields.find(f => f.id === id);
            const old = cur ? cur.value : null;
            if (cur) cur.value = cf.value; else issue.custom_fields.push({ id, name: `cf_${id}`, value: cf.value });
            details.push({ property: 'cf', name: String(id), old_value: old === null ? null : String(old), new_value: String(cf.value) });
        }
    }
    const notes = typeof patch.notes === 'string' ? patch.notes : '';
    if (!notes && !details.length) return { changed: false };
    const now = nowIso();
    issue.journals.push({ id: store.next_journal_id++, user: { id: USER.id, name: USER.name }, notes, created_on: now, details });
    issue.updated_on = now;
    return { changed: true };
}

// Lê o corpo inteiro (até MAX_BODY). Nunca rejeita: devolve { text } ou { tooLarge }.
function readBody(req) {
    return new Promise(resolve => {
        let size = 0; let tooLarge = false; const chunks = [];
        req.on('data', c => {
            size += c.length;
            if (size > MAX_BODY) { tooLarge = true; chunks.length = 0; return; }
            if (!tooLarge) chunks.push(c);
        });
        req.on('end', () => resolve(tooLarge ? { tooLarge: true } : { text: Buffer.concat(chunks).toString('utf8') }));
        req.on('error', () => resolve({ aborted: true }));
    });
}

// A chave nunca vai para o log, nem quando o cliente a manda na query.
function safeQuery(url) {
    const q = new URLSearchParams(url.search);
    if (q.has('key')) q.set('key', '<redacted>');
    const s = q.toString();
    return s ? `?${s}` : '';
}

function unknownParams(url, allowed) {
    return [...new Set([...url.searchParams.keys()])].filter(k => !allowed.has(k));
}

function createServer({ store: storeFile, key, log }) {
    if (!key) throw new Error('--key é obrigatório');
    const writeLog = entry => {
        if (!log) return;
        try { fs.appendFileSync(log, JSON.stringify({ ts: nowIso(), ...entry }) + '\n'); } catch { /* log é auxílio, não estado */ }
    };
    // Um request por vez sobre o store: leitura e escrita nunca se cruzam. O corpo é lido antes
    // de entrar na fila, então um cliente lento não trava os outros.
    let chain = Promise.resolve();
    const serial = fn => (chain = chain.then(fn, fn));

    const handle = async (req, res, body) => {
        const url = new URL(req.url, `http://${HOST}`);
        const send = (status, payload, handled = true) => {
            writeLog({ method: req.method, path: url.pathname, query: safeQuery(url), status, handled });
            if (payload === undefined) { res.writeHead(status); res.end(); return; }
            res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(payload));
        };
        try {
            if (req.headers['x-redmine-api-key'] !== key) return send(401, { errors: ['chave inválida'] });
            if (body.aborted) return send(400, { errors: ['corpo interrompido'] });
            if (body.tooLarge) return send(413, { errors: ['corpo grande demais'] });
            const store = loadStore(storeFile);
            if (req.method === 'GET' && url.pathname === '/issues.json') {
                const extra = unknownParams(url, LIST_PARAMS);
                if (extra.length) return send(422, { errors: [`filtro fora do subconjunto do piloto: ${extra.join(', ')}`] }, false);
                return send(200, listIssues(store, url));
            }
            if (req.method === 'GET' && url.pathname === '/users/current.json') return send(200, { user: { ...USER } });
            if (req.method === 'GET' && url.pathname === '/issue_statuses.json') return send(200, { issue_statuses: STATUSES });
            const m = url.pathname.match(/^\/issues\/(\d+)\.json$/);
            if (m && (req.method === 'GET' || req.method === 'PUT')) {
                const extra = unknownParams(url, ISSUE_PARAMS);
                if (extra.length) return send(422, { errors: [`parâmetro fora do subconjunto do piloto: ${extra.join(', ')}`] }, false);
                const issue = store.issues.find(i => i.id === Number(m[1]));
                if (!issue) return send(404, { errors: ['ticket não existe'] });
                if (req.method === 'GET') return send(200, { issue: view(issue, includes(url)) });
                let parsed;
                try { parsed = JSON.parse(body.text || '{}'); } catch { return send(400, { errors: ['JSON inválido'] }); }
                const r = applyUpdate(store, issue, parsed && parsed.issue);
                if (r.error) return send(422, { errors: [r.error] }, !r.unhandled);
                if (r.changed) saveStore(storeFile, store);
                return send(204);
            }
            return send(404, { errors: ['rota não suportada pelo Redmine local'] }, false);
        } catch (e) {
            return send(500, { errors: [e.message] });
        }
    };

    const server = http.createServer(async (req, res) => {
        const body = await readBody(req);
        serial(() => handle(req, res, body));
    });
    // Trava do store enquanto escuta: o seed recusa rodar com o servidor de pé.
    server.on('listening', () => { try { fs.writeFileSync(lockFile(storeFile), String(process.pid)); } catch { /* sem trava, o seed não é protegido */ } });
    server.on('close', () => { try { fs.unlinkSync(lockFile(storeFile)); } catch { /* já removida */ } });
    return server;
}

// Sempre em loopback: é o único jeito de subir o servidor pelo CLI.
function listen(server, port) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, HOST, () => resolve(server.address()));
    });
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
        listen(server, port).then(addr => console.log(`Redmine local do piloto em http://${addr.address}:${addr.port} (store ${store})`),
            e => { console.error(`pilot-redmine: ${e.message}`); process.exit(2); });
        const stop = () => server.close(() => process.exit(0));
        process.on('SIGTERM', stop);
        process.on('SIGINT', stop);
        return server;
    }
    throw new Error('uso: pilot-redmine.js serve|seed --store <arquivo> ...');
}

module.exports = { createServer, listen, seed, loadStore, listIssues, applyUpdate, STATUSES, HOST, USER };

if (require.main === module) {
    try { main(process.argv.slice(2)); } catch (e) { console.error(`pilot-redmine: ${e.message}`); process.exit(2); }
}
