// "✨ Corrigir com IA" do portão de build pré-implement (dashboard > POST
// /api/runs/:taskId/pre-build/ai-fix). Quando o `mvn compile` da base falha depois do
// /plan, o dashboard despacha um `claude -p` no worktree do ticket só pra fazer a base
// compilar de novo, e transmite cada passo do agente (texto, ferramenta, resultado)
// pro painel ao vivo. Quem valida no fim é o mesmo build-validator do watcher — o
// "passou" do agente não conta.
//
// Este módulo não sabe nada de HTTP/state.json: monta prompt e args, interpreta o
// --output-format stream-json e controla o processo (timeout, cancelamento).
const { spawn: nodeSpawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { withClaudeAccount } = require('./claude-account');

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_EVENT_TEXT = 2000;
const SIBLING_REPOS = (process.env.WATCHER_SIBLING_REPOS || '').split(',').map(s => s.trim()).filter(Boolean);

// PRE_BUILD_AI_FIX_TIMEOUT_MS sobrescreve o padrão (20 min). Valor inválido cai no padrão.
function resolveTimeoutMs(env = process.env) {
    const n = Number(env.PRE_BUILD_AI_FIX_TIMEOUT_MS);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_TIMEOUT_MS;
}

// Worktrees irmãos do mesmo ticket (<workspace>/<repo>/.claude/worktrees/<ticket>) —
// erro de símbolo pode estar no app-core/mo-entity do ticket, não no app-back.
function siblingWorktrees(workspace, ticketId) {
    return SIBLING_REPOS.map(r => path.join(workspace, r, '.claude', 'worktrees', String(ticketId))).filter(p => fs.existsSync(p));
}

function buildPrompt({ ticketId, errors, extra = '', siblingDirs = [], command, env = process.env }) {
    command = command || env.PRE_BUILD_COMMAND;
    if (!command) throw new Error('PRE_BUILD_COMMAND não configurado pelo consumidor');
    const install = siblingDirs.length
        ? `- Dependências locais: verifique apenas os worktrees DESTE ticket:\n` +
          `${siblingDirs.map(d => `  ${d}`).join('\n')}\n` +
          `  Leia memory/project.yaml e seus documentos de referência para o procedimento e a ordem de dependências do consumidor. ` +
          `Nunca opere no checkout principal de um repo irmão nem em worktree de outro ticket.\n`
        : '';
    return (
        `Você foi despachado pelo dashboard do watcher (botão "Corrigir com IA" do portão de build pré-implement) ` +
        `no worktree do ticket #${ticketId}. O \`${command}\` falhou DEPOIS do /plan e ANTES de qualquer ` +
        `implementação — a base do ticket não compila. Sua única tarefa é fazer a base compilar de novo.\n\n` +
        `Erros reportados pelo portão (${errors.length}):\n${errors.join('\n')}\n\n` +
        `Regras:\n` +
        `- Corrija só o necessário pra compilar. Não implemente o ticket, não refatore, não mude comportamento.\n` +
        `- Não faça commit, push, merge, rebase nem troque de branch. Não mexa em memory/ nem no .env.\n` +
        `- Rode \`${command}\` pra confirmar; repita até passar.\n` +
        install +
        `- Se a causa for de ambiente, NÃO contorne mudando código: explique o que rodar e pare.\n` +
        `- Termine com um resumo curto em português: causa, arquivos alterados e se o build passou.` +
        (extra ? `\n\nObservação do usuário: ${extra}` : '')
    );
}

function claudeArgs(prompt, { addDirs = [], sessionId = null } = {}) {
    return [
        '-p', prompt,
        '--output-format', 'stream-json', '--verbose',
        '--permission-mode', 'acceptEdits',
        '--allowedTools', 'Read,Edit,Write,Bash,Grep,Glob',
        '--disallowedTools', 'Agent,Task',
        ...(sessionId ? ['--session-id', sessionId] : []),
        ...addDirs.flatMap(d => ['--add-dir', d]),
    ];
}

function clip(text, max = MAX_EVENT_TEXT) {
    const s = String(text ?? '');
    return s.length > max ? `${s.slice(0, max)}…` : s;
}

// Uma linha curta por chamada de ferramenta — é o que o painel mostra como "passo".
function describeTool(name, input = {}, cwd = null) {
    const rel = p => (cwd && typeof p === 'string' && p.startsWith(cwd + path.sep) ? p.slice(cwd.length + 1) : p);
    switch (name) {
        case 'Bash': return `$ ${clip(input.command, 300)}`;
        case 'Read': return `Lendo ${rel(input.file_path)}`;
        case 'Edit': return `Editando ${rel(input.file_path)}`;
        case 'Write': return `Escrevendo ${rel(input.file_path)}`;
        case 'Grep': return `Buscando "${clip(input.pattern, 120)}"${input.path ? ` em ${rel(input.path)}` : ''}`;
        case 'Glob': return `Listando ${clip(input.pattern, 120)}`;
        case 'TodoWrite': return 'Atualizando plano de passos';
        default: return name;
    }
}

function toolResultText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map(c => (typeof c === 'string' ? c : c?.text || '')).join('\n');
    return '';
}

// Linha do stream-json -> eventos do painel. Retorna [] pro que não interessa.
// Tipos: start | text | tool | tool_error | result | log.
function parseStreamLine(line, { cwd = null } = {}) {
    const raw = String(line || '').trim();
    if (!raw) return [];
    let msg;
    try { msg = JSON.parse(raw); } catch { return [{ kind: 'log', text: clip(raw, 500) }]; }
    if (msg.type === 'system' && msg.subtype === 'init') return [{ kind: 'start', text: `Sessão iniciada${msg.model ? ` (${msg.model})` : ''}` }];
    if (msg.type === 'assistant') {
        return (msg.message?.content || []).flatMap(c => {
            if (c.type === 'text' && c.text?.trim()) return [{ kind: 'text', text: clip(c.text.trim()) }];
            if (c.type === 'tool_use') return [{ kind: 'tool', tool: c.name, text: describeTool(c.name, c.input, cwd) }];
            return [];
        });
    }
    if (msg.type === 'user') {
        return (msg.message?.content || [])
            .filter(c => c.type === 'tool_result' && c.is_error)
            .map(c => ({ kind: 'tool_error', text: clip(toolResultText(c.content), 600) }));
    }
    if (msg.type === 'result') {
        return [{
            kind: 'result', error: msg.is_error === true || msg.subtype !== 'success',
            text: clip(msg.result || (msg.subtype !== 'success' ? `Agente terminou com ${msg.subtype}` : ''), 4000),
            costUsd: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : null,
            durationMs: typeof msg.duration_ms === 'number' ? msg.duration_ms : null,
            turns: typeof msg.num_turns === 'number' ? msg.num_turns : null,
        }];
    }
    return [];
}

// Env do agente: sem as variáveis CLAUDE* da sessão que subiu o dashboard (mesma regra
// de cleanAgentEnv no watcher) e com o JDK que o build-validator escolheu pro worktree.
function agentEnv(env = process.env, javaHome = null) {
    const out = { ...env };
    for (const k of Object.keys(out)) if (k.startsWith('CLAUDE') || k === 'AI_AGENT') delete out[k];
    withClaudeAccount(out, env);
    if (javaHome) {
        out.JAVA_HOME = javaHome;
        out.PATH = `${path.join(javaHome, 'bin')}${path.delimiter}${out.PATH || ''}`;
    }
    return out;
}

/**
 * Sobe o agente. onEvent recebe cada evento já interpretado (sem redação — quem
 * transmite redige). Devolve { pid, cancel(), done } — done resolve com
 * { code, cancelled, timedOut, result } (result = último evento "result" ou null).
 */
function startFix({ worktree, args, env, onEvent = () => {}, spawn = nodeSpawn, bin = 'claude', timeoutMs = DEFAULT_TIMEOUT_MS }) {
    const child = spawn(bin, args, { cwd: worktree, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let cancelled = false, timedOut = false, result = null, buf = '';
    const emit = ev => { if (ev.kind === 'result') result = ev; try { onEvent(ev); } catch { /* painel nunca derruba o agente */ } };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            parseStreamLine(line, { cwd: worktree }).forEach(emit);
        }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => chunk.split('\n').filter(l => l.trim()).forEach(l => emit({ kind: 'log', text: clip(l, 500) })));
    const kill = () => { try { child.kill('SIGTERM'); } catch { /* já saiu */ } setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* idem */ } }, 5000).unref(); };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const done = new Promise(resolve => {
        const finish = code => {
            clearTimeout(timer);
            if (buf.trim()) parseStreamLine(buf, { cwd: worktree }).forEach(emit);
            buf = '';
            resolve({ code, cancelled, timedOut, result });
        };
        child.on('close', finish);
        child.on('error', e => { emit({ kind: 'log', text: `Falha ao iniciar \`${bin}\`: ${e.message}` }); finish(null); });
    });
    return { pid: child.pid, cancel: () => { cancelled = true; kill(); }, done };
}

module.exports = {
    buildPrompt, claudeArgs, parseStreamLine, describeTool, agentEnv, startFix, siblingWorktrees,
    resolveTimeoutMs, DEFAULT_TIMEOUT_MS,
};
