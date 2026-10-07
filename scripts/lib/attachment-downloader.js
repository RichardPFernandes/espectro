// Download e conversão dos anexos de um ticket Redmine, pro nó fetch_ticket.
// A API do Redmine devolve só metadados (content_url, filename, content_type) — sem
// isto, prints de tela, PDFs de requisito e planilhas nunca chegavam ao /plan e a
// implementação saía só do texto do ticket (quase sempre incompleto).
//
// Por tipo:
//   - imagem (png/jpeg/gif/webp) → salva original; o agente lê via visão (Read);
//   - PDF  → original + .txt via `pdftotext` (poppler) — sem o binário, só o PDF + aviso;
//   - DOCX → original + .md via mammoth;
//   - XLSX → original + .csv (primeira sheet) via xlsx/SheetJS;
//   - resto (zip, código, executável...) → salva sem abrir, type "raw".
// Extensão executável/compactada (ver RAW_ONLY_EXTENSIONS) sempre vira raw, mesmo que
// o content_type declare imagem/PDF — nunca abrimos/convertermos esses arquivos.
//
// Falha num anexo NUNCA interrompe os outros nem o fetch_ticket: vai pra `skipped`
// com o motivo. Acima de maxSizeBytes (padrão 10 MB, env MAX_ATTACHMENT_SIZE_MB) o
// arquivo não é baixado (reason "size_exceeded").
//
// Autenticação: Basic com a API key como usuário E senha (o Redmine aceita a key no
// lugar de user:pass). A key só é enviada pra origem de REDMINE_URL — content_url de
// outro host é remontado sobre REDMINE_URL pelo id (ver downloadUrl), nunca seguido.
// NUNCA logar a key nem o header Authorization: toda saída (stdout, stderr, manifesto)
// passa pelo sanitize-log.js como rede de segurança.
//
// Uso como CLI (anexos = array JSON de issue.attachments, via stdin ou --attachments):
//   node scripts/lib/attachment-downloader.js <ticket-id> [--dest <dir>] [--attachments '<json>'] < anexos.json
//   Destino padrão: memory/spec/<ticket-id>-attachments/ (relativo ao cwd, igual à spec).
//   Grava <dest>/attachments.json (manifesto) e imprime o mesmo resultado em stdout.
//   exit 0 = rodou (mesmo com anexos pulados/falhos), 2 = uso incorreto.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { buildSanitizer } = require('../sanitize-log');

const DEFAULT_MAX_SIZE_MB = 10;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const CONVERT_TIMEOUT_MS = 60_000;
const EXCERPT_CHARS = 600;
const CSV_PREVIEW_LINES = 3;
const MANIFEST_NAME = 'attachments.json';
const MAX_REDIRECTS = 3;

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Nunca processados, independente do content_type declarado.
const RAW_ONLY_EXTENSIONS = new Set([
    '.js', '.mjs', '.cjs', '.ts', '.sh', '.bash', '.zsh', '.py', '.rb', '.pl', '.php',
    '.jar', '.war', '.ear', '.class', '.exe', '.dll', '.so', '.dylib', '.bat', '.cmd',
    '.ps1', '.vbs', '.msi', '.apk', '.app', '.dmg', '.com', '.scr',
    '.zip', '.rar', '.7z', '.tar', '.gz', '.tgz', '.bz2', '.xz',
    '.docm', '.xlsm', '.pptm', '.html', '.htm', '.svg',
]);

function maxSizeFromEnv(env = process.env) {
    const mb = Number(env.MAX_ATTACHMENT_SIZE_MB);
    return (Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_MAX_SIZE_MB) * 1024 * 1024;
}

function classify(att) {
    const ext = path.extname(att.filename || '').toLowerCase();
    const type = String(att.content_type || '').toLowerCase().split(';')[0].trim();
    if (RAW_ONLY_EXTENSIONS.has(ext)) return 'raw';
    if (IMAGE_TYPES.has(type) || ((type === 'application/octet-stream' || !type) && IMAGE_EXTENSIONS.has(ext))) return 'image';
    if (type === 'application/pdf' || ext === '.pdf') return 'pdf';
    if (type === DOCX_TYPE || ext === '.docx') return 'docx';
    if (type === XLSX_TYPE || ext === '.xlsx') return 'xlsx';
    return 'raw';
}

// Nome vindo do Redmine é entrada não confiável: sem diretório, sem caractere de
// controle/separador, sem começar com ponto (evita arquivo oculto e ".."). Colisão
// (dois anexos com o mesmo nome, ou nome igual a um derivado) ganha prefixo com o id.
function safeFilename(att, used) {
    let name = path.basename(String(att.filename || '').replace(/\\/g, '/'))
        .replace(/[\x00-\x1f\x7f<>:"|?*/]/g, '_')
        .replace(/^\.+/, '')
        .trim();
    if (!name || name === MANIFEST_NAME) name = `anexo-${att.id}${name ? '-' + name : ''}`;
    if (used.has(name.toLowerCase())) name = `${att.id}-${name}`;
    return name;
}

function derivedName(filename, newExt, used) {
    const base = filename.slice(0, filename.length - path.extname(filename).length) || filename;
    let name = `${base}${newExt}`;
    if (used.has(name.toLowerCase())) name = `${filename}${newExt}`;
    return name;
}

function sameOrigin(a, b) {
    try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
}

// O Redmine monta content_url com o host_name da configuração dele, que pode não ser
// o endereço por onde a API é acessada (aqui: IP interno 192.168.10.205:3000 vs
// REDMINE_URL público). Então a URL é remontada sobre REDMINE_URL pela rota padrão
// /attachments/download/:id/:filename — a credencial só vai pra REDMINE_URL, e o host
// do content_url nunca é usado. Sem id numérico, só aceita content_url da mesma origem.
function downloadUrl(att, redmineUrl) {
    if (!redmineUrl) return null;
    if (sameOrigin(att.content_url, redmineUrl)) return att.content_url;
    if (!/^\d+$/.test(String(att.id))) return null;
    return `${redmineUrl.replace(/\/+$/, '')}/attachments/download/${att.id}/${encodeURIComponent(att.filename || 'anexo')}`;
}

class SizeExceededError extends Error {
    constructor(size) { super('size_exceeded'); this.size = size; }
}

async function downloadTo(url, dest, { apiKey, maxSizeBytes, fetchImpl }) {
    // Redirect seguido à mão, e só dentro da mesma origem: a credencial nunca segue
    // pra outro host, independente do comportamento do fetch em redirect cross-origin.
    let res;
    for (let hop = 0; ; hop++) {
        res = await fetchImpl(url, {
            headers: { Authorization: `Basic ${Buffer.from(`${apiKey}:${apiKey}`).toString('base64')}` },
            redirect: 'manual',
            signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        });
        if (res.status < 300 || res.status >= 400) break;
        const next = res.headers.get('location');
        await res.body?.cancel?.();
        if (!next || hop >= MAX_REDIRECTS) throw new Error(`redirect inválido (HTTP ${res.status})`);
        const target = new URL(next, url).href;
        if (!sameOrigin(target, url)) throw new Error('redirect pra outra origem — credencial não enviada');
        url = target;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxSizeBytes) {
        await res.body?.cancel?.();
        throw new SizeExceededError(declared);
    }
    // Metadado do Redmine pode mentir/faltar: o limite vale também durante o stream.
    const out = fs.createWriteStream(dest);
    let total = 0;
    try {
        for await (const chunk of res.body) {
            total += chunk.length;
            if (total > maxSizeBytes) throw new SizeExceededError(total);
            if (!out.write(chunk)) await new Promise(r => out.once('drain', r));
        }
        await new Promise((resolve, reject) => out.end(err => (err ? reject(err) : resolve())));
    } catch (err) {
        // Espera o close: o open do stream é assíncrono, e um rm antes dele deixaria o
        // arquivo parcial ser (re)criado depois.
        await new Promise(resolve => { out.once('close', resolve); out.destroy(); });
        fs.rmSync(dest, { force: true });
        throw err;
    }
    return total;
}

function run(cmd, args) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { timeout: CONVERT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) { err.stderr = stderr; reject(err); } else resolve(stdout);
        });
    });
}

async function findPdftotext(explicit) {
    if (explicit !== undefined) return explicit;
    try { return (await run('which', ['pdftotext'])).trim() || null; } catch { return null; }
}

function excerptOf(text) {
    const clean = text.replace(/\s+/g, ' ').trim();
    return clean.length > EXCERPT_CHARS ? `${clean.slice(0, EXCERPT_CHARS)}…` : clean;
}

// Cada conversor recebe o arquivo já salvo e devolve { converted, excerpt?, warnings }.
// Erro de conversão vira aviso — o original continua salvo e útil.
const converters = {
    async pdf(file, destDir, used, ctx) {
        const bin = await findPdftotext(ctx.pdftotextPath);
        if (!bin) return { warnings: ['pdftotext não encontrado (instale poppler: brew install poppler) — salvo só o PDF.'] };
        const txt = derivedName(path.basename(file), '.txt', used);
        await run(bin, [file, path.join(destDir, txt)]);
        return { converted: txt, excerpt: excerptOf(fs.readFileSync(path.join(destDir, txt), 'utf8')) };
    },
    async docx(file, destDir, used) {
        const mammoth = require('mammoth');
        const md = derivedName(path.basename(file), '.md', used);
        const { value, messages } = await mammoth.convertToMarkdown({ path: file });
        fs.writeFileSync(path.join(destDir, md), value);
        const warnings = messages.filter(m => m.type === 'error').map(m => `mammoth: ${m.message}`);
        return { converted: md, excerpt: excerptOf(value), warnings };
    },
    async xlsx(file, destDir, used) {
        const XLSX = require('xlsx');
        const wb = XLSX.readFile(file);
        const first = wb.SheetNames[0];
        if (!first) return { warnings: ['planilha sem sheets — salvo só o .xlsx.'] };
        const csvText = XLSX.utils.sheet_to_csv(wb.Sheets[first]);
        const csv = derivedName(path.basename(file), '.csv', used);
        fs.writeFileSync(path.join(destDir, csv), csvText);
        const warnings = wb.SheetNames.length > 1
            ? [`${wb.SheetNames.length} sheets — convertida só a primeira ("${first}").`]
            : [];
        return { converted: csv, excerpt: csvText.split('\n').slice(0, CSV_PREVIEW_LINES).join('\n'), sheet: first, warnings };
    },
};

async function downloadAttachments(attachments, destDir, options = {}) {
    const {
        maxSizeBytes = maxSizeFromEnv(options.env),
        apiKey = (options.env || process.env).REDMINE_API_KEY,
        redmineUrl = (options.env || process.env).REDMINE_URL,
        fetchImpl = fetch,
        pdftotextPath, // undefined = descobre com `which`; null = força "indisponível" (testes)
        onWarning = () => {},
    } = options;
    const downloaded = [];
    const skipped = [];
    const list = Array.isArray(attachments) ? attachments : [];
    if (list.length === 0) return { downloaded, skipped };

    fs.mkdirSync(destDir, { recursive: true });
    const used = new Set();
    const ctx = { pdftotextPath };

    for (const att of list) {
        const filename = safeFilename(att, used);
        const type = classify(att);
        const base = { id: att.id, filename: att.filename, content_type: att.content_type || null };
        const skip = (reason, extra = {}) => {
            skipped.push({ ...base, reason, ...extra });
            onWarning(`anexo ${att.id} (${att.filename}) ignorado: ${reason}${extra.error ? ` — ${extra.error}` : ''}`);
        };

        if (Number(att.filesize) > maxSizeBytes) { skip('size_exceeded', { filesize: Number(att.filesize), max_size_bytes: maxSizeBytes }); continue; }
        if (!att.content_url) { skip('missing_content_url'); continue; }
        if (!apiKey) { skip('missing_api_key'); continue; }
        const url = downloadUrl(att, redmineUrl);
        if (!url) { skip('foreign_host', { error: 'content_url fora da origem de REDMINE_URL — credencial não enviada' }); continue; }

        used.add(filename.toLowerCase());
        const file = path.join(destDir, filename);
        let size;
        try {
            size = await downloadTo(url, file, { apiKey, maxSizeBytes, fetchImpl });
        } catch (err) {
            used.delete(filename.toLowerCase());
            if (err instanceof SizeExceededError) skip('size_exceeded', { filesize: err.size, max_size_bytes: maxSizeBytes });
            else skip('download_failed', { error: err.message });
            continue;
        }

        const result = { ...base, type, path: file, saved_as: filename, filesize: size, warnings: [] };
        if (converters[type]) {
            try {
                const conv = await converters[type](file, destDir, used, ctx);
                if (conv.converted) {
                    used.add(conv.converted.toLowerCase());
                    result.converted_path = path.join(destDir, conv.converted);
                }
                if (conv.excerpt !== undefined) result.excerpt = conv.excerpt;
                if (conv.sheet) result.sheet = conv.sheet;
                result.warnings.push(...(conv.warnings || []));
            } catch (err) {
                result.warnings.push(`conversão ${type} falhou: ${err.message} — original salvo.`);
            }
        }
        result.warnings.forEach(w => onWarning(`anexo ${att.id} (${att.filename}): ${w}`));
        downloaded.push(result);
    }
    return { downloaded, skipped };
}

// --- CLI ---------------------------------------------------------------------------

// Mesmo formato/semântica do loadDotEnv do readmine-watcher.js: nunca sobrescreve env
// já setada.
function loadDotEnv(envPath) {
    if (!fs.existsSync(envPath)) return;
    for (const rawLine of fs.readFileSync(envPath, 'utf8').split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (!(key in process.env)) process.env[key] = value;
    }
}

function parseArgs(argv) {
    const out = { ticketId: null, dest: null, attachments: null };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--dest') out.dest = argv[++i];
        else if (argv[i] === '--attachments') out.attachments = argv[++i];
        else if (!out.ticketId) out.ticketId = argv[i];
    }
    return out;
}

async function main() {
    loadDotEnv(path.join(process.env.REPO_PATH || process.cwd(), '.env'));
    const sanitize = buildSanitizer(process.env, { onWarning: () => {} });
    const warn = msg => process.stderr.write(`[anexos] ${sanitize(msg)}\n`);
    const args = parseArgs(process.argv.slice(2));
    if (!args.ticketId || !/^\d+$/.test(args.ticketId)) {
        process.stderr.write('uso: node attachment-downloader.js <ticket-id> [--dest <dir>] [--attachments <json>] (ou JSON via stdin)\n');
        process.exit(2);
    }
    let raw = args.attachments;
    if (raw == null) raw = process.stdin.isTTY ? '[]' : fs.readFileSync(0, 'utf8');
    let attachments;
    try {
        const parsed = JSON.parse(raw.trim() || '[]');
        // Aceita o array puro, { attachments: [...] } ou o { issue: {...} } da API.
        attachments = Array.isArray(parsed) ? parsed : parsed.attachments || parsed.issue?.attachments || [];
    } catch (err) {
        process.stderr.write(`JSON de anexos inválido: ${sanitize(err.message)}\n`);
        process.exit(2);
    }
    const destDir = path.resolve(args.dest || path.join('memory', 'spec', `${args.ticketId}-attachments`));
    const result = await downloadAttachments(attachments, destDir, { onWarning: warn });
    const json = sanitize(JSON.stringify({ ticket_id: Number(args.ticketId), dest_dir: destDir, max_size_bytes: maxSizeFromEnv(), ...result }, null, 2));
    if (attachments.length > 0) fs.writeFileSync(path.join(destDir, MANIFEST_NAME), json + '\n');
    process.stdout.write(json + '\n');
}

if (require.main === module) {
    main().catch(err => {
        // Rede de segurança: mesmo um erro inesperado não deve quebrar o fetch_ticket.
        const sanitize = buildSanitizer(process.env, { onWarning: () => {} });
        process.stderr.write(`[anexos] erro inesperado: ${sanitize(err.stack || err.message)}\n`);
        process.stdout.write(JSON.stringify({ downloaded: [], skipped: [], error: sanitize(err.message) }) + '\n');
    });
}

module.exports = { downloadAttachments, classify, safeFilename, maxSizeFromEnv };
