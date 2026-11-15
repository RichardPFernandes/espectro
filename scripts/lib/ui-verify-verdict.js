'use strict';
// Veredito da verificação de UI (PRI-355). Função pura: recebe o que o agente viu no
// navegador e devolve PASSOU | FALHOU | N/A | SKIPPED com a lista de problemas.
// Fail-closed: dado ausente, fora de formato ou não verificável nunca vira PASSOU.

const DEFAULT_FRONTEND_GLOBS = ['dashboard/public/**'];
const MAX_PROBLEMS = 50;
const LEVELS = new Set(['error', 'warning', 'info', 'debug', 'log']);

// Só `*`, `**` e `?` são curingas; o resto é literal. `**/` casa zero ou mais pastas.
function globToRegExp(glob) {
    let g = glob.trim().replace(/^\.\//, '');
    let re = '';
    for (let i = 0; i < g.length; i++) {
        const c = g[i];
        if (c === '*' && g[i + 1] === '*') {
            if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
        } else if (c === '*') re += '[^/]*';
        else if (c === '?') re += '[^/]';
        else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${re}$`);
}

function touchesFrontend(files, globs = DEFAULT_FRONTEND_GLOBS) {
    const res = globs.map(globToRegExp);
    return files.some(f => res.some(re => re.test(f)));
}

function originOf(url) {
    try { return new URL(url).origin; } catch { return null; }
}

// Host "externo" = nome DNS público. Loopback, IP literal, localhost (com ponto final), *.localhost e
// *.local nunca contam: um app que não alcança o próprio backend local é falha real.
function isExternalHost(hostname) {
    const h = hostname.toLowerCase().replace(/\.$/, '');
    if (!h.includes('.') || /^[\d.]+$/.test(h) || h.startsWith('[') || h.includes(':')) return false;
    return !(h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local'));
}

// O --allowed-origins do próprio MCP bloqueia recursos externos (fontes, CDN): efeito do sandbox,
// não da tela. Só isenta se o texto tem URL(s) e TODAS são de host externo; qualquer URL do app ou de
// loopback (ou texto sem URL) mantém o erro.
function isSandboxBlock(text, appOrigins) {
    if (!/ERR_BLOCKED_BY_CLIENT/.test(text)) return false;
    const urls = text.match(/https?:\/\/[^\s)'"]+/g) || [];
    if (!urls.length) return false;
    return urls.every(u => {
        const origin = originOf(u);
        if (!origin || appOrigins.includes(origin)) return false;
        return isExternalHost(new URL(origin).hostname);
    });
}

// Só inteiro HTTP 100-599, como número ou string de 3 dígitos. Lista, boolean, fração e "failed" não valem.
function numericStatus(status) {
    const ok = (typeof status === 'number' && Number.isInteger(status)) || (typeof status === 'string' && /^\d{3}$/.test(status));
    const n = ok ? Number(status) : NaN;
    return n >= 100 && n <= 599 ? n : null;
}

function screenProblems(screen, { exists, appOrigins }) {
    if (!screen || typeof screen !== 'object' || Array.isArray(screen)) {
        return [{ code: 'INVALID_FINDINGS', where: 'run', detail: 'tela não é um objeto' }];
    }
    const where = `${screen.ac || 'sem-AC'} ${screen.url || ''}`.trim();
    const out = [];
    const bad = detail => out.push({ code: 'INVALID_FINDINGS', where, detail });
    if (typeof screen.ac !== 'string' || !screen.ac.trim()) bad('tela sem AC: não dá para ligar ao critério');
    if (appOrigins.length && !appOrigins.includes(originOf(screen.url))) bad(`url fora da origem da verificação: ${String(screen.url).slice(0, 80)}`);
    if (typeof screen.screenshot !== 'string' || !screen.screenshot.trim() || !exists(screen.screenshot)) {
        out.push({ code: 'NO_SCREENSHOT', where, detail: `screenshot ausente ou inexistente: ${screen.screenshot ?? 'null'}` });
    }
    if (!Array.isArray(screen.console)) bad('console não é uma lista');
    else {
        for (const m of screen.console) {
            const level = typeof m?.level === 'string' ? m.level.toLowerCase() : null;
            if (!LEVELS.has(level)) { bad(`mensagem de console sem level reconhecido: ${JSON.stringify(m).slice(0, 120)}`); continue; }
            if (level === 'error' && !isSandboxBlock(String(m.text), appOrigins)) {
                out.push({ code: 'CONSOLE_ERROR', where, detail: String(m.text).slice(0, 300) });
            }
        }
    }
    if (!Array.isArray(screen.requests)) bad('requests não é uma lista');
    else if (!screen.requests.length) {
        out.push({ code: 'INCOMPLETE_FINDINGS', where, detail: 'nenhuma requisição registrada (navegar sempre gera ao menos a do documento)' });
    } else {
        for (const r of screen.requests) {
            const status = numericStatus(r?.status);
            if (status === null) out.push({ code: 'REQUEST_FAILED', where, detail: `requisição sem status HTTP (falha de rede?): ${r?.url ?? '?'}` });
            else if (status >= 400) out.push({ code: 'HTTP_ERROR', where, detail: `${status} ${r.url}` });
        }
    }
    if (!Array.isArray(screen.expected)) bad('expected não é uma lista');
    else if (!screen.expected.length) {
        out.push({ code: 'INCOMPLETE_FINDINGS', where, detail: 'nenhum elemento esperado verificado nesta tela' });
    } else {
        for (const e of screen.expected) {
            if (typeof e?.selector !== 'string' || !e.selector.trim()) bad(`elemento esperado sem texto/seletor: ${JSON.stringify(e).slice(0, 120)}`);
            else if (typeof e.found !== 'boolean') bad(`found deve ser boolean: ${JSON.stringify(e).slice(0, 120)}`);
            else if (!e.found) out.push({ code: 'ELEMENT_MISSING', where, detail: `elemento esperado ausente: ${e.selector}` });
        }
    }
    return out;
}

function verdict({ enabled, touchesFrontend: touches, requiredAcs = [], findings, exists = () => false, appOrigins = [] }) {
    if (!enabled) return { verdict: 'SKIPPED', problems: [], reason: 'PRISMA_UI_VERIFY=off' };
    if (!touches) return { verdict: 'N/A', problems: [], reason: 'diff sem frontend' };
    if (!requiredAcs.length) return { verdict: 'N/A', problems: [], reason: 'spec sem AC de UI' };
    if (!findings || typeof findings !== 'object' || Array.isArray(findings) || !Array.isArray(findings.screens)) {
        return { verdict: 'FALHOU', problems: [{ code: 'INVALID_FINDINGS', where: 'run', detail: 'findings sem lista "screens"' }] };
    }
    if (!findings.screens.length) {
        return { verdict: 'FALHOU', problems: [{ code: 'NO_EVIDENCE', where: 'run', detail: 'AC de UI sem nenhuma tela verificada' }] };
    }
    const problems = findings.screens.flatMap(s => screenProblems(s, { exists, appOrigins }));
    const seen = new Set(findings.screens.map(s => s?.ac));
    for (const ac of requiredAcs) {
        if (!seen.has(ac)) problems.push({ code: 'AC_NOT_COVERED', where: ac, detail: 'AC de UI sem nenhuma tela verificada' });
    }
    // O veredito é calculado sobre tudo; só a lista que sai é limitada (não inundar contexto nem disco).
    const omitted = Math.max(0, problems.length - MAX_PROBLEMS);
    return { verdict: problems.length ? 'FALHOU' : 'PASSOU', problems: problems.slice(0, MAX_PROBLEMS), ...(omitted ? { omitted } : {}) };
}

function formatReport(result) {
    const lines = [`Veredito: ${result.verdict}${result.reason ? ` (${result.reason})` : ''}`];
    for (const p of result.problems) lines.push(`- [${p.code}] ${p.where}: ${p.detail}`);
    if (result.omitted) lines.push(`... +${result.omitted} problemas omitidos`);
    return lines.join('\n');
}

module.exports = { DEFAULT_FRONTEND_GLOBS, touchesFrontend, verdict, formatReport };
