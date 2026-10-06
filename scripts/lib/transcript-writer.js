// Transcrição completa do agente por nó, pra post-mortem de ciclo. Hoje só o artefato
// final de cada nó (context.md/handoff.md/state.json) sobrevive ao `claude -p`; o
// raciocínio e as decisões intermediárias ficam só no transcript JSONL da sessão em
// ~/.claude/projects/. Este módulo copia isso pra dentro da task:
//
//   memory/runs/<task-id>/transcripts/<node>-<attempt>.json      (ou .json.gz)
//   memory/runs/<task-id>/transcripts/index.json                  (cópia autoritativa)
//
// e espelha o índice em state.json.transcripts / transcripts_total /
// transcripts_size_bytes (ver .graph/schemas/state.schema.json).
//
// Conteúdo é SENSÍVEL (prompt, diff, saída de ferramenta): fica só em disco local,
// nunca é enviado a serviço externo, e passa pela mesma redação de secrets do .log
// (sanitize) antes de ser gravado. Chamado pelo watcher como efeito colateral puro:
// quem chama protege com try/catch — falha aqui nunca derruba o ciclo.
const fs = require('fs');
const path = require('path');
const stateWriter = require('../state-writer');
const zlib = require('zlib');

const TRANSCRIPTS_DIR = 'transcripts';
const INDEX_FILE = 'index.json';
const DEFAULT_GZIP_THRESHOLD_BYTES = 100 * 1024;
const STATUSES = new Set(['success', 'failed']);
// Mesma regra de nome que o endpoint do dashboard aceita — impede path traversal via
// nodeId/taskId vindos de state.json.
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

// TRANSCRIPT_GZIP_THRESHOLD_BYTES: acima disto grava .json.gz. 0 = nunca comprime.
function gzipThresholdFromEnv(env = process.env) {
    const raw = env.TRANSCRIPT_GZIP_THRESHOLD_BYTES;
    if (raw === undefined || raw === '') return DEFAULT_GZIP_THRESHOLD_BYTES;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_GZIP_THRESHOLD_BYTES;
}

function transcriptsDir(taskDir) {
    return path.join(taskDir, TRANSCRIPTS_DIR);
}

function readIndex(taskDir) {
    try {
        const list = JSON.parse(fs.readFileSync(path.join(transcriptsDir(taskDir), INDEX_FILE), 'utf8'));
        return Array.isArray(list) ? list : [];
    } catch {
        return [];
    }
}

// Próxima tentativa do nó = maior attempt já gravado + 1 (retry do review→implement
// gera implement-2, implement-3...).
function nextAttempt(taskDir, nodeId) {
    const attempts = readIndex(taskDir).filter(t => t.nodeId === nodeId).map(t => Number(t.attempt) || 0);
    return attempts.length ? Math.max(...attempts) + 1 : 1;
}

function summarize(list) {
    return {
        transcripts: list,
        transcripts_total: list.length,
        transcripts_size_bytes: list.reduce((acc, t) => acc + (t.sizeBytes || 0), 0),
    };
}

// Aplica o índice no state.json da task. Nunca toca updated_at (mesma regra do
// cost_tracking: métrica/diagnóstico não decide despacho).
function applyIndexToState(taskDir, list = readIndex(taskDir)) {
    const state = stateWriter.update(taskDir, s => { Object.assign(s, summarize(list)); }, { operation: 'transcripts_index', actor: 'watcher' });
    if (!state) throw new Error(`${path.join(taskDir, 'state.json')}: ausente ou ilegível`);
    return state;
}

function normalizeMessage(m) {
    const content = typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '');
    const out = { role: String(m?.role || 'unknown'), content, timestamp: m?.timestamp || null };
    if (m?.source) out.source = m.source;
    return out;
}

// Grava a transcrição de UMA tentativa de UM nó. taskDir = diretório da task (pode
// estar em memory/runs/_archive/ quando o /commit já arquivou). Devolve a entrada do
// índice ({nodeId, attempt, path, sizeBytes, status, tokenUsage, ...}).
// options: { taskDir (obrigatório), gzipThresholdBytes, sanitize(str) => str }.
// attempt null/0 = próxima tentativa do nó (nextAttempt).
//
// Síncrono de propósito: o watcher chama isto no começo do tick e, no mesmo tick, pode
// adquirir lease e despachar o próximo agente — um read-modify-write assíncrono do
// state.json intercalado com isso perderia a escrita de um dos dois.
function writeTranscriptSync(taskId, nodeId, attempt, conversation, metadata = {}, options = {}) {
    const { taskDir, sanitize = s => s } = options;
    if (!taskDir) throw new Error('writeTranscript: options.taskDir é obrigatório');
    if (!SAFE_SEGMENT.test(String(taskId)) || !SAFE_SEGMENT.test(String(nodeId))) {
        throw new Error(`writeTranscript: taskId/nodeId inválido (${taskId}/${nodeId})`);
    }
    const n = Number.isInteger(attempt) && attempt > 0 ? attempt : nextAttempt(taskDir, nodeId);
    const status = STATUSES.has(metadata.status) ? metadata.status : 'failed';
    const threshold = options.gzipThresholdBytes ?? gzipThresholdFromEnv();

    const messages = (Array.isArray(conversation) ? conversation : []).map(normalizeMessage)
        .map(m => ({ ...m, content: sanitize(m.content) }));
    const doc = {
        taskId: String(taskId),
        nodeId: String(nodeId),
        attempt: n,
        metadata: {
            model: metadata.model ?? null,
            startedAt: metadata.startedAt ?? null,
            finishedAt: metadata.finishedAt ?? null,
            tokenUsage: metadata.tokenUsage ?? null,
            status,
            ...Object.fromEntries(Object.entries(metadata).filter(([k]) =>
                !['model', 'startedAt', 'finishedAt', 'tokenUsage', 'status'].includes(k))),
        },
        conversation: messages,
    };

    const dir = transcriptsDir(taskDir);
    fs.mkdirSync(dir, { recursive: true });
    // Worktree de ticket pode estar numa branch que ainda versiona memory/runs — sem
    // isto um `git add memory/` do /commit levaria a transcrição pro PR (Bitbucket).
    const ignore = path.join(dir, '.gitignore');
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '# Transcrições são sensíveis: nunca versionar.\n*\n');
    const json = Buffer.from(JSON.stringify(doc, null, 2));
    const compress = threshold > 0 && json.length > threshold;
    const fileName = `${nodeId}-${n}.json${compress ? '.gz' : ''}`;
    const body = compress ? zlib.gzipSync(json) : json;
    // Escrita atômica: o dashboard pode estar lendo o arquivo ao mesmo tempo.
    const tmp = path.join(dir, `.${fileName}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, path.join(dir, fileName));

    const entry = {
        nodeId: String(nodeId),
        attempt: n,
        path: `${TRANSCRIPTS_DIR}/${fileName}`,
        sizeBytes: body.length,
        compressed: compress,
        status,
        tokenUsage: doc.metadata.tokenUsage,
        messages: messages.length,
        finishedAt: doc.metadata.finishedAt,
    };
    // Mesmo nó+tentativa regravado (ex: .json virou .json.gz) substitui a entrada.
    const same = t => t.nodeId === entry.nodeId && t.attempt === entry.attempt;
    const previous = readIndex(taskDir);
    for (const stale of previous.filter(t => same(t) && t.path !== entry.path)) {
        if (/^transcripts\/[A-Za-z0-9._-]+$/.test(stale.path)) fs.rmSync(path.join(taskDir, stale.path), { force: true });
    }
    const list = [...previous.filter(t => !same(t)), entry];
    fs.writeFileSync(path.join(dir, INDEX_FILE), JSON.stringify(list, null, 2));
    if (fs.existsSync(path.join(taskDir, 'state.json'))) applyIndexToState(taskDir, list);
    return entry;
}

// API assíncrona (mesma assinatura/semântica de writeTranscriptSync).
async function writeTranscript(taskId, nodeId, attempt, conversation, metadata = {}, options = {}) {
    return writeTranscriptSync(taskId, nodeId, attempt, conversation, metadata, options);
}

// Lê uma transcrição gravada (.json ou .json.gz). null = não existe.
function readTranscriptFile(file) {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file);
    return JSON.parse((file.endsWith('.gz') ? zlib.gunzipSync(raw) : raw).toString('utf8'));
}

// ---------------------------------------------------------------------------------
// Conversão do transcript JSONL do Claude Code (uma linha por bloco de conteúdo:
// text / thinking / tool_use / tool_result) pro formato padronizado {role, content,
// timestamp}. Tolerante a resposta parcial: linha truncada/JSON inválido é pulada e
// contada em `skippedLines`, entrada de tipo desconhecido é ignorada. Nunca lança.

const MAX_BLOCK_CHARS = 20000;

function clip(text) {
    const s = String(text ?? '');
    return s.length > MAX_BLOCK_CHARS ? `${s.slice(0, MAX_BLOCK_CHARS)}\n… [truncado: ${s.length - MAX_BLOCK_CHARS} caracteres]` : s;
}

function blockToText(block) {
    if (typeof block === 'string') return { kind: 'text', text: block };
    if (!block || typeof block !== 'object') return null;
    switch (block.type) {
        case 'text':
            return { kind: 'text', text: block.text || '' };
        case 'thinking':
            return block.thinking ? { kind: 'thinking', text: `[thinking]\n${block.thinking}` } : null;
        case 'redacted_thinking':
            return null;
        case 'tool_use':
            return { kind: 'tool_use', text: `[tool_use ${block.name || '?'}] ${clip(JSON.stringify(block.input ?? {}))}` };
        case 'tool_result': {
            const inner = Array.isArray(block.content)
                ? block.content.map(c => (c?.type === 'text' ? c.text : `[${c?.type || 'bloco'}]`)).join('\n')
                : String(block.content ?? '');
            return { kind: 'tool_result', text: `[tool_result${block.is_error ? ' ERRO' : ''}] ${clip(inner)}` };
        }
        case 'image':
            return { kind: 'text', text: '[imagem]' };
        default:
            return { kind: 'text', text: `[${block.type || 'bloco'}]` };
    }
}

function entryToMessages(entry, source) {
    const ts = entry.timestamp || null;
    if (entry.type === 'system') {
        const text = entry.content ?? entry.subtype;
        return text ? [{ role: 'system', content: clip(text), timestamp: ts, source }] : [];
    }
    if (entry.type !== 'user' && entry.type !== 'assistant') return [];
    const msg = entry.message;
    if (!msg) return [];
    const blocks = typeof msg.content === 'string' ? [msg.content] : Array.isArray(msg.content) ? msg.content : [];
    const out = [];
    for (const b of blocks) {
        const r = blockToText(b);
        if (!r || !r.text) continue;
        // tool_result chega como "user" na API — pra leitura, é saída de ferramenta.
        const role = r.kind === 'tool_result' ? 'tool' : (msg.role || entry.type);
        out.push({ role, content: clip(r.text), timestamp: ts, source });
    }
    if (entry.isApiErrorMessage && out.length) out.forEach(m => { m.apiError = true; });
    return out;
}

// files: [{content: string, source: 'main' | 'subagent:<nome>'}].
function conversationFromClaudeJsonl(files) {
    const conversation = [];
    let skippedLines = 0;
    let apiError = false;
    for (const { content, source } of files) {
        for (const line of String(content || '').split('\n')) {
            if (!line.trim()) continue;
            let entry;
            try { entry = JSON.parse(line); } catch { skippedLines++; continue; }
            if (entry.isApiErrorMessage) apiError = true;
            conversation.push(...entryToMessages(entry, source));
        }
    }
    // Principal + subagentes intercalados em ordem cronológica (sort estável: sem
    // timestamp mantém a ordem original do arquivo).
    const withIdx = conversation.map((m, i) => ({ m, i, t: Date.parse(m.timestamp) }));
    withIdx.sort((a, b) => (Number.isFinite(a.t) && Number.isFinite(b.t) ? a.t - b.t : 0) || a.i - b.i);
    return { conversation: withIdx.map(x => x.m), skippedLines, apiError };
}

module.exports = {
    writeTranscript, writeTranscriptSync, readTranscriptFile, readIndex, nextAttempt, applyIndexToState, summarize,
    conversationFromClaudeJsonl, gzipThresholdFromEnv,
    TRANSCRIPTS_DIR, INDEX_FILE, DEFAULT_GZIP_THRESHOLD_BYTES, SAFE_SEGMENT,
};
