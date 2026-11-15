#!/usr/bin/env node
// PreToolUse (mcp__playwright__.*): PRI-355. O `filename` das ferramentas do Playwright MCP é
// resolvido contra a raiz do workspace e não é confinado pelo --output-dir. Sem este guard, conteúdo
// da página (texto injetado) poderia sobrescrever .mcp.json, settings ou package.json.
// Regras (fail-closed: qualquer dúvida ou erro nega):
//  - `filename` só em `.prisma/ui-verify/<task-id>/...` (ao menos um subdiretório; symlinks resolvidos);
//  - `url` de browser_navigate/browser_tabs só em http://localhost|127.0.0.1:$PRISMA_UI_PORT;
//  - `paths` (upload/drop) nunca.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const deny = reason => ({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `playwright-fs-guard: ${reason}` },
});

// realpath do ancestral existente mais próximo + o resto: resolve symlinks mesmo para arquivo que ainda não existe.
function realish(p) {
    const rest = [];
    let cur = p;
    for (;;) {
        try { return path.join(fs.realpathSync(cur), ...rest.reverse()); } catch { /* sobe */ }
        const up = path.dirname(cur);
        if (up === cur) return p;
        rest.push(path.basename(cur));
        cur = up;
    }
}

export function decide(input, env = process.env) {
    const ti = input?.tool_input;
    if (!ti || typeof ti !== 'object') return deny('entrada sem tool_input');
    const root = path.resolve(env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());
    if (ti.paths !== undefined) return deny('`paths` (upload/drop) não é permitido');
    if (ti.filename !== undefined && ti.filename !== null) {
        const f = ti.filename;
        if (typeof f !== 'string' || !f.trim() || f.includes('\0')) return deny(`filename inválido (${String(f).slice(0, 40)})`);
        const allowed = realish(path.join(root, '.prisma', 'ui-verify'));
        const rel = path.relative(allowed, realish(path.resolve(root, f))).split(path.sep);
        // <task-id>/arquivo: dentro da pasta e com pelo menos um subdiretório (nada na raiz de ui-verify).
        const taskOk = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(rel[0]) && !/^server\./i.test(rel[0]);
        if (rel.length < 2 || !taskOk) {
            return deny(`filename fora de .prisma/ui-verify/<task-id>/ (${f.slice(0, 80)}). Salve screenshots, snapshots e logs só ali.`);
        }
    }
    const tool = String(input.tool_name || '');
    if (/browser_(navigate|tabs)$/.test(tool) && ti.url !== undefined) {
        const port = String(env.PRISMA_UI_PORT || '3399');
        const re = new RegExp(`^http://(localhost|127\\.0\\.0\\.1):${port}(/|\\?|#|$)`);
        if (typeof ti.url !== 'string' || !/^\d{2,5}$/.test(port) || !re.test(ti.url)) return deny(`url fora de localhost:${port} (${String(ti.url).slice(0, 80)})`);
    }
    return null;
}

async function main() {
    try {
        let raw = '';
        for await (const chunk of process.stdin) raw += chunk;
        const out = decide(JSON.parse(raw));
        if (out) process.stdout.write(JSON.stringify(out));
    } catch (e) {
        process.stdout.write(JSON.stringify(deny(`erro ao avaliar (${String(e.message).slice(0, 80)}); negado por segurança`)));
    }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
