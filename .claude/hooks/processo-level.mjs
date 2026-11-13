#!/usr/bin/env node
// PreToolUse (Write|Edit): aviso cedo do Acordo v2. Se `.prisma/level` diz
// `leve`, nega criar ou editar SPEC, handoff ou evidence separado (mesmos globs
// do processo-check, em .github/processo.json). Sem o arquivo, não bloqueia.
// É contornável (basta apagar ou trocar o arquivo); a barreira real é o CI.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, matchesAny } from '../../.github/scripts/processo-lib.mjs';

// Raiz do checkout que contém o arquivo (o `.git` mais próximo), para cobrir
// worktrees fora de CLAUDE_PROJECT_DIR. Sem `.git` acima, usa a raiz do projeto.
function rootFor(file, fallback) {
    let dir = path.dirname(file);
    for (;;) {
        if (fs.existsSync(path.join(dir, '.git'))) return dir;
        const up = path.dirname(dir);
        if (up === dir) return fallback;
        dir = up;
    }
}

export function decide(input, env = process.env) {
    const project = env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
    const file = input?.tool_input?.file_path;
    if (!file) return null;
    const abs = path.resolve(project, file);
    const root = rootFor(abs, project);
    let level;
    try {
        level = fs.readFileSync(path.join(root, '.prisma', 'level'), 'utf8').trim().toLowerCase();
    } catch {
        return null;
    }
    if (level !== 'leve') return null;
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (rel.startsWith('../') || rel === '..' || path.isAbsolute(rel)) return null;
    const { leve } = loadConfig();
    if (!matchesAny(rel, leve.forbiddenNewFiles, { ignoreCase: true })) return null;
    return {
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: `Nível leve (.prisma/level): sem SPEC, handoff ou evidence separado (${rel}). A evidência vai na seção Evidência do PR. Se o trabalho passou do nível, peça reclassificação ao Richard.`,
        },
    };
}

async function main() {
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    const out = decide(JSON.parse(raw || '{}'));
    if (out) process.stdout.write(JSON.stringify(out));
}

const invoked = (() => { try { return pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch { return ''; } })();
if (invoked && import.meta.url === invoked) {
    // Falha do hook não bloqueia (exit ≠ 2): o aviso é cedo, não barreira.
    main().catch((e) => { console.error(`processo-level: ${e.message}`); process.exitCode = 1; });
}
