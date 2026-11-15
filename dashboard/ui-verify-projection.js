'use strict';
// Projeção somente leitura de .prisma/ui-verify/<task-id>/ (PRI-361): veredito, achados e screenshots
// que o /verify-ui gravou (PRI-355). Não escreve, não cria writer nem estado novo.
// Fail-closed: veredito ausente, ilegível, de tipo errado ou incoerente é UNKNOWN, nunca PASSOU.
// Segurança de caminho: nome de task e de imagem por allowlist, symlink nunca é seguido (lstat) e a
// imagem servida precisa estar, por realpath, dentro da pasta da task.
const fs = require('fs');
const path = require('path');

const TASK_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,123}\.png$/;
const VERDICTS = new Set(['PASSOU', 'FALHOU', 'N/A', 'SKIPPED']);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TASKS_DEFAULT = 100;
const MAX_PROBLEMS = 50;
const MAX_SCREENS = 50;
const MAX_IMAGES = 100;
const MAX_TEXT = 300;

const isTaskId = v => typeof v === 'string' && TASK_RE.test(v);
const isImageName = v => typeof v === 'string' && IMAGE_RE.test(v);
const text = (v, max = MAX_TEXT) => String(v ?? '').slice(0, max);

function lstat(p) {
    try { return fs.lstatSync(p); } catch { return null; }
}

// Arquivo regular (não symlink), limitado em tamanho; qualquer falha devolve null.
function readJsonFile(file) {
    const st = lstat(file);
    if (!st || !st.isFile() || st.size > MAX_JSON_BYTES) return null;
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function hasPngMagic(file) {
    let fd;
    try {
        fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(PNG_MAGIC.length);
        return fs.readSync(fd, buf, 0, buf.length, 0) === buf.length && buf.equals(PNG_MAGIC);
    } catch { return false; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
}

function isRealPng(file) {
    const st = lstat(file);
    return !!st && st.isFile() && st.size <= MAX_IMAGE_BYTES && hasPngMagic(file);
}

function listImages(dir) {
    let names;
    try { names = fs.readdirSync(dir); } catch { return []; }
    return names.filter(isImageName).filter(n => isRealPng(path.join(dir, n))).sort().slice(0, MAX_IMAGES);
}

function readVerdict(dir) {
    const raw = readJsonFile(path.join(dir, 'verdict.json'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { verdict: 'UNKNOWN', reason: 'veredito ausente ou ilegível', problems: [] };
    }
    if (!VERDICTS.has(raw.verdict)) return { verdict: 'UNKNOWN', reason: 'veredito com valor desconhecido', problems: [] };
    const problemsRaw = Array.isArray(raw.problems) ? raw.problems : null;
    if (problemsRaw === null) return { verdict: 'UNKNOWN', reason: 'veredito sem lista de problemas', problems: [] };
    const problems = problemsRaw.slice(0, MAX_PROBLEMS).map(p => ({
        code: text(p?.code, 60), where: text(p?.where, 160), detail: text(p?.detail),
    }));
    if (raw.verdict === 'PASSOU' && problemsRaw.length) {
        return { verdict: 'UNKNOWN', reason: 'PASSOU com problemas listados: veredito incoerente', problems };
    }
    const out = { verdict: raw.verdict, problems };
    if (typeof raw.reason === 'string' && raw.reason) out.reason = text(raw.reason);
    const omitted = Number.isInteger(raw.omitted) && raw.omitted > 0 ? raw.omitted : 0;
    if (omitted) out.omitted = omitted;
    return out;
}

// Nome do PNG de um screenshot dos achados, só se ele aponta para a pasta desta task (ou é um nome
// solto). `.prisma/ui-verify/OUTRA/a.png` e `../x/a.png` não ligam ao `a.png` desta task.
function shotName(screenshot, taskId) {
    if (typeof screenshot !== 'string') return null;
    const parts = screenshot.split(/[\\/]/);
    const name = parts[parts.length - 1];
    if (parts.length > 1 && parts[parts.length - 2] !== taskId) return null;
    return name;
}

function readScreens(dir, images, taskId) {
    const raw = readJsonFile(path.join(dir, 'findings.json'));
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.screens)) return [];
    return raw.screens.slice(0, MAX_SCREENS).filter(s => s && typeof s === 'object' && !Array.isArray(s)).map(s => {
        const expected = Array.isArray(s.expected) ? s.expected : [];
        const consoleList = Array.isArray(s.console) ? s.console : [];
        const shot = shotName(s.screenshot, taskId);
        return {
            ac: text(s.ac, 60),
            url: text(s.url, 200),
            image: shot && images.includes(shot) ? shot : null,
            expected: { total: expected.length, found: expected.filter(e => e && e.found === true).length },
            consoleErrors: consoleList.filter(m => String(m?.level).toLowerCase() === 'error').length,
            requests: Array.isArray(s.requests) ? s.requests.length : 0,
        };
    });
}

// Quando a task foi mexida pela última vez: o mais novo entre veredito e achados (só lstat, sem parse).
function activityMs(root, taskId) {
    const dir = path.join(root, taskId);
    const m = ['verdict.json', 'findings.json'].map(f => lstat(path.join(dir, f))?.mtimeMs).filter(Number.isFinite);
    return m.length ? Math.max(...m) : (lstat(dir)?.mtimeMs ?? 0);
}

function readTask(root, taskId) {
    const dir = path.join(root, taskId);
    const images = listImages(dir);
    let v = readVerdict(dir);
    // O /verify-ui só apaga o veredito quando roda `verdict`. Se a rodada nova regravou achados ou PNGs e
    // caiu antes disso, o veredito que sobrou é da rodada anterior: não vale para o que a tela mostra.
    const verdictAt = lstat(path.join(dir, 'verdict.json'))?.mtimeMs;
    if (v.verdict !== 'UNKNOWN' && Number.isFinite(verdictAt)) {
        const evidence = [lstat(path.join(dir, 'findings.json'))?.mtimeMs, ...images.map(n => lstat(path.join(dir, n))?.mtimeMs)].filter(Number.isFinite);
        if (evidence.length && Math.max(...evidence) > verdictAt) {
            v = { verdict: 'UNKNOWN', reason: 'veredito anterior aos achados ou às capturas: rode o verdict de novo', problems: v.problems };
        }
    }
    const updated = activityMs(root, taskId);
    return { taskId, ...v, screens: readScreens(dir, images, taskId), images, updatedAt: updated ? new Date(updated).toISOString() : null };
}

// Lista as verificações da pasta `root`, da mais recente para a mais antiga. Só as `limit` mais recentes
// são lidas e interpretadas.
function listVerifications(root, { limit = MAX_TASKS_DEFAULT } = {}) {
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
    const n = Number.isInteger(limit) && limit > 0 ? limit : MAX_TASKS_DEFAULT;
    return entries
        .filter(e => e.isDirectory() && !e.isSymbolicLink() && isTaskId(e.name))
        .map(e => ({ taskId: e.name, at: activityMs(root, e.name) }))
        .sort((a, b) => b.at - a.at || a.taskId.localeCompare(b.taskId))
        .slice(0, n)
        .map(e => readTask(root, e.taskId));
}

// Bytes de um PNG da task, ou null. Abre com O_NOFOLLOW e valida no mesmo descritor (arquivo regular,
// tamanho, assinatura PNG), então trocar o arquivo por symlink ou outro conteúdo depois da checagem não
// muda o que sai daqui. A pasta da task precisa ser diretório real (lstat), nunca symlink.
function readImage(root, taskId, file) {
    if (!isTaskId(taskId) || !isImageName(file)) return null;
    const dirStat = lstat(path.join(root, taskId));
    if (!dirStat || !dirStat.isDirectory()) return null;
    let fd;
    try {
        fd = fs.openSync(path.join(root, taskId, file), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const st = fs.fstatSync(fd);
        if (!st.isFile() || st.size > MAX_IMAGE_BYTES || st.size < PNG_MAGIC.length) return null;
        const buf = Buffer.alloc(st.size);
        let off = 0;
        while (off < buf.length) {
            const got = fs.readSync(fd, buf, off, buf.length - off, off);
            if (!got) break;
            off += got;
        }
        return off === buf.length && buf.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC) ? buf : null;
    } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
}

module.exports = { listVerifications, readImage, isTaskId, isImageName };
