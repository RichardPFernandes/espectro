// Auto-repair da spec: quando o portão (scripts/lib/spec-validator.js) rejeita a spec,
// gera as seções obrigatórias que faltam a partir do ticket do Redmine, como SUGESTÃO.
// Nada aqui escreve na spec: o resultado vira memory/spec/<id>-spec.draft.md e um
// comentário no Redmine; só uma resposta "aprovado" (SPEC_APPROVAL_KEYWORD) faz o
// watcher chamar mergeDraft() — ver runTicketSpecGate/runTaskSpecGate em
// scripts/readmine-watcher.js.
//
// Claude é chamado do mesmo jeito que o watcher despacha agentes (`claude -p`, sem SDK
// no projeto), mas sem ferramenta nenhuma, sem sessão persistida e com cwd temporário
// (nada de CLAUDE.md/settings do projeto). Secrets: saem do env do processo filho e são
// redigidos do prompt e da resposta (scripts/sanitize-log.js). Falha, indisponibilidade
// ou timeout (SPEC_REPAIR_TIMEOUT_MS, padrão 120s) nunca derrubam o fluxo: as seções
// voltam com PLACEHOLDER.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const specValidator = require('./spec-validator');
const { withClaudeAccount } = require('./claude-account');
const sanitizeLog = require('../sanitize-log');

// Ticket grande (dezenas de regras + cenários Gherkin) passa de 30s fácil — com 30s o
// rascunho do #43746 saiu sem Solução/Critérios por timeout (32s).
const DEFAULT_TIMEOUT_MS = 120 * 1000;
const PLACEHOLDER = 'A definir — revisar com o responsável pelo ticket.';
const DRAFT_MARKER = '<!-- spec-repairer:';

// SPEC_REPAIR_TIMEOUT_MS sobrescreve o padrão (120s). Valor inválido cai no padrão.
function resolveTimeoutMs(env = process.env) {
    const n = Number(env.SPEC_REPAIR_TIMEOUT_MS);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_TIMEOUT_MS;
}

const sectionDef = key => specValidator.REQUIRED_SECTIONS.find(d => d.key === key) || null;

// Ordem das seções no draft/comentário: a do templates/spec-template.md (não a de
// REQUIRED_SECTIONS, que lista por importância pro portão).
const TEMPLATE_ORDER = ['problema_contexto', 'solucao', 'criterios_aceite'];

// Aceita key ("solucao"), heading ("Solução") ou label ("## Solução") — o que vier do
// validador ou de quem chamar à mão. Desconhecidos são descartados; ordem do template.
function resolveSections(missingSections) {
    const wanted = new Set();
    for (const raw of missingSections || []) {
        const norm = specValidator.normalizeHeading(String(raw).replace(/^#+\s*/, ''));
        const def = specValidator.REQUIRED_SECTIONS.find(d =>
            d.key === raw || d.match.test(norm) || specValidator.normalizeHeading(d.heading) === norm);
        if (def) wanted.add(def.key);
    }
    return TEMPLATE_ORDER.filter(k => wanted.has(k)).map(sectionDef);
}

// Seção ("## X" + corpo) que é SÓ placeholder: resposta vazia/ilegível, ou o Claude achou
// o ticket vago demais. Placeholder num item de uma seção preenchida é ponto pra revisão,
// não seção vazia — descartar a seção inteira por isso perdia a Solução do #43746.
function isPlaceholderOnly(sectionMd) {
    const lines = String(sectionMd || '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .split('\n')
        .filter(l => !/^\s*#{1,6}\s/.test(l))
        .map(l => l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim())
        .filter(Boolean);
    return !lines.length || lines.every(l => l === PLACEHOLDER);
}

function placeholderBody(def) {
    // Critérios precisam ser lista pro validador reconhecer a seção como preenchida.
    return def.key === 'criterios_aceite' ? `- ${PLACEHOLDER}` : PLACEHOLDER;
}

function buildSystemPrompt(defs) {
    return 'Você é um assistente de especificação técnica. Com base no título e descrição do ticket ' +
        'Redmine abaixo, gere APENAS as seções faltantes da spec de forma objetiva. Não invente ' +
        'detalhes que não estejam no ticket. Se o ticket for muito vago para uma seção, escreva ' +
        `'${PLACEHOLDER}' Seções a gerar: ${defs.map(d => `## ${d.heading}`).join(', ')}\n\n` +
        'Formato da resposta: só Markdown, cada seção começando exatamente pelo cabeçalho indicado ' +
        '(nível ##), sem introdução, sem conclusão e sem repetir seções que já existem na spec. ' +
        '"## Critérios de Aceite" deve ser uma lista com um critério verificável por linha, cada um com ID ' +
        'estável em sequência a partir do próximo número livre da spec atual (spec sem critérios: "- AC-01: ...", ' +
        '"- AC-02: ..."). Nunca renumere nem repita um ID que a spec já usa.';
}

function customFieldLines(ticket) {
    return (ticket.custom_fields || [])
        .filter(f => f && f.name && f.value !== undefined && f.value !== null && String(f.value).trim() !== '')
        .map(f => `- ${f.name}: ${Array.isArray(f.value) ? f.value.join(', ') : f.value}`);
}

function buildUserPrompt({ specContent, ticketData, defs }) {
    const t = ticketData || {};
    const fields = customFieldLines(t);
    return [
        `# Ticket Redmine #${t.id ?? '?'}`,
        `Título: ${t.subject || '(sem título)'}`,
        `Tipo: ${t.tracker?.name || '?'}`,
        t.category?.name ? `Categoria: ${t.category.name}` : null,
        fields.length ? `Campos customizados:\n${fields.join('\n')}` : null,
        '',
        '## Descrição do ticket',
        (t.description || '').trim() || '(vazia)',
        '',
        '# Spec atual (NÃO repita o que já está aqui)',
        String(specContent || '').trim() || '(vazia)',
        '',
        `# Gere somente: ${defs.map(d => `## ${d.heading}`).join(', ')}`,
    ].filter(l => l !== null).join('\n');
}

// Env do filho: igual ao dos agentes (sem CLAUDE*/AI_AGENT, ver cleanAgentEnv no
// watcher) e sem nenhuma variável com cara de secret — BITBUCKET_API_TOKEN,
// REDMINE_API_KEY etc. Só a credencial da própria Anthropic, se existir, fica.
const SECRET_NAME = /(TOKEN|API_KEY|SECRET|PASSWORD|PASSWD)$/i;
function childEnv(env = process.env) {
    const out = {};
    for (const [k, v] of Object.entries(env)) {
        if (k.startsWith('CLAUDE') || k === 'AI_AGENT') continue;
        if (SECRET_NAME.test(k) && !k.startsWith('ANTHROPIC_')) continue;
        out[k] = v;
    }
    return withClaudeAccount(out, env);
}

// Chama `claude -p` com o prompt no stdin. Resolve {ok, output, reason} — nunca rejeita.
function runClaudeCli({ system, prompt, timeoutMs, bin = process.env.SPEC_REPAIR_CLAUDE_BIN || 'claude' }) {
    return new Promise(resolve => {
        const args = ['-p', '--system-prompt', system, '--tools', '', '--no-session-persistence',
            '--output-format', 'text', '--strict-mcp-config'];
        if (process.env.SPEC_REPAIR_MODEL) args.push('--model', process.env.SPEC_REPAIR_MODEL);
        let child;
        try {
            child = spawn(bin, args, { cwd: os.tmpdir(), env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
        } catch (e) {
            resolve({ ok: false, output: '', reason: e.message });
            return;
        }
        let out = '', settled = false;
        const done = r => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
        const timer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch {}
            done({ ok: false, output: out, reason: `timeout de ${timeoutMs}ms` });
        }, timeoutMs);
        child.stdout.on('data', d => { out += d; });
        child.stderr.on('data', () => {}); // stderr pode ecoar env/config — descartado
        child.on('error', e => done({ ok: false, output: '', reason: e.message }));
        child.on('close', code => done(code === 0 ? { ok: true, output: out } : { ok: false, output: out, reason: `exit ${code}` }));
        child.stdin.on('error', () => {});
        child.stdin.end(prompt);
    });
}

// Resposta do Claude → {key: corpo}, só pras seções pedidas. Cabeçalho reconhecido com a
// mesma tolerância do validador (#..####, acento, sufixo). Corpo vazio = não gerado.
function parseGenerated(output, defs) {
    const lines = String(output || '').replace(/\r\n?/g, '\n').split('\n');
    const sections = specValidator.parseSections(lines);
    const bodies = {};
    for (const def of defs) {
        const s = specValidator.findSection(sections, def);
        if (!s) continue;
        const body = s.body.join('\n').replace(/^\n+|\s+$/g, '');
        if (body.trim()) bodies[def.key] = body;
    }
    return bodies;
}

function renderSections(defs, bodies) {
    return defs.map(d => `## ${d.heading}\n\n${bodies[d.key] || placeholderBody(d)}`).join('\n\n');
}

/**
 * Gera as seções faltantes da spec. Nunca rejeita: em falha/timeout, cada seção sai
 * com PLACEHOLDER (e o motivo vai em `onFallback`, pra quem quiser logar).
 * @param {{specContent: string, ticketData: object, missingSections: string[],
 *   timeoutMs?: number, runClaude?: Function, env?: object, onFallback?: (reason: string) => void}} args
 * @returns {Promise<string>} Markdown só com as seções geradas (`## Heading` + corpo).
 */
async function repairSpec({ specContent, ticketData, missingSections, timeoutMs,
    runClaude = runClaudeCli, env = process.env, onFallback = () => {} }) {
    if (timeoutMs == null) timeoutMs = resolveTimeoutMs(env);
    const defs = resolveSections(missingSections);
    if (!defs.length) return '';
    const redact = sanitizeLog.buildSanitizer(env, { onWarning: () => {} });
    const system = buildSystemPrompt(defs);
    const prompt = redact(buildUserPrompt({ specContent, ticketData, defs }));
    let bodies = {};
    try {
        const r = await runClaude({ system, prompt, timeoutMs });
        if (r && r.ok) bodies = parseGenerated(redact(r.output), defs);
        else onFallback(r?.reason || 'sem resposta');
    } catch (e) {
        onFallback(e.message);
    }
    return renderSections(defs, bodies);
}

// Arquivo do draft: marcador (comentário HTML — o validador ignora) + seções.
function formatDraftFile({ ticketId, sectionsMd, generatedAt = new Date().toISOString() }) {
    return `${DRAFT_MARKER} rascunho gerado por IA para o ticket #${ticketId} em ${generatedAt}. ` +
        'NÃO é a spec: só entra nela depois da aprovação no Redmine. -->\n\n' +
        `${sectionsMd.trim()}\n`;
}

// Intervalo [start, end) das linhas da seção (cabeçalho incluso) no texto CRU da spec.
// Mesma noção de fim de seção do validador: próximo cabeçalho de nível igual/superior.
function sectionRange(lines, def) {
    const headings = [];
    lines.forEach((l, idx) => { const h = specValidator.parseHeading(l); if (h) headings.push({ ...h, idx }); });
    for (let i = 0; i < headings.length; i++) {
        const h = headings[i];
        if (!def.match.test(specValidator.normalizeHeading(h.text))) continue;
        let end = lines.length;
        for (let j = i + 1; j < headings.length; j++) {
            if (headings[j].level <= h.level) { end = headings[j].idx; break; }
        }
        return { start: h.idx, end };
    }
    return null;
}

/**
 * Mescla o draft na spec. Só entra seção que AINDA falta na spec atual (se o humano
 * editou a spec depois do draft, o que ele escreveu vence): ausente → anexada no fim;
 * vazia → corpo inserido sob o cabeçalho existente; critérios insuficientes → itens do
 * draft somados aos existentes.
 * @returns {{content: string, merged: string[], skipped: string[]}}
 */
function mergeDraft(specContent, draftContent) {
    const spec = String(specContent || '').replace(/\r\n?/g, '\n');
    const draftLines = specValidator.stripComments(String(draftContent || '')).replace(/\r\n?/g, '\n').split('\n');
    const draftSections = specValidator.parseSections(draftLines);
    const stillMissing = new Set(specValidator.validateSpec(spec).missingSections);
    let lines = spec.split('\n');
    const merged = [], skipped = [], appended = [];

    for (const def of specValidator.REQUIRED_SECTIONS) {
        const ds = specValidator.findSection(draftSections, def);
        if (!ds) continue;
        const body = ds.body.join('\n').replace(/^\n+|\s+$/g, '');
        if (!body.trim() || !stillMissing.has(def.key)) { skipped.push(def.key); continue; }
        const range = sectionRange(lines, def);
        if (!range) {
            appended.push(`## ${def.heading}\n\n${body}`);
        } else {
            // Vazia ou com critérios de menos: corpo do draft vai no fim da seção existente.
            let at = range.end;
            while (at > range.start + 1 && !lines[at - 1].trim()) at--;
            lines = [...lines.slice(0, at), ...(at === range.start + 1 ? [''] : []), ...body.split('\n'), '', ...lines.slice(range.end)];
        }
        merged.push(def.key);
    }
    let content = lines.join('\n');
    if (appended.length) content = `${content.replace(/\s+$/, '')}\n\n${appended.join('\n\n')}\n`;
    return { content, merged, skipped };
}

// Seções do draft em bloco diff (tudo é adição — nada da spec atual é alterado).
function formatDiff(sectionsMd) {
    const body = String(sectionsMd || '').trim().split('\n').map(l => (l ? `+ ${l}` : '+')).join('\n');
    return '```diff\n' + body + '\n```';
}

/**
 * Comentário do Redmine com o draft. Começa por SPEC_REPAIR_COMMENT_PREFIX (é por ele
 * que o watcher acha o pedido nos journals). Deixa claro que é IA e oferece as três
 * saídas: aprovar o draft, editar a spec, ou seguir sem nada ("aceito", portão antigo).
 */
function formatRepairComment({ ticketId, result, sectionsMd, specLocation, draftPath, keyword, sourceLabel }) {
    const parts = [
        `${specValidator.SPEC_REPAIR_COMMENT_PREFIX} (ticket #${ticketId}).`,
        '',
        '⚠️ O texto abaixo foi escrito por IA a partir do título/descrição deste ticket — pode conter erros ' +
        'ou omissões. **Revise antes de aprovar.** O ciclo (plan → implement → review → test) ficou pausado.',
        '',
        `Fonte validada: ${sourceLabel}.`,
        '',
        '**Pendências:**',
        ...result.errors.map(e => `- ${e.message}`),
        '',
        '**Seções faltantes sugeridas:**',
        '',
        formatDiff(sectionsMd),
        '',
        `**Para aprovar:** responda este comentário com '${keyword}'. As seções acima entram na spec e o ciclo segue sozinho no próximo tick.`,
        '',
        `**Para editar:** atualize a spec em ${specLocation} e o watcher revalida automaticamente no próximo tick.`,
        '',
        '**Para seguir sem a sugestão:** responda com um comentário começando por "aceito" — a spec segue ' +
        'incompleta e as pendências viram aviso pro /plan.',
        '',
        `Rascunho salvo em \`${draftPath}\` (a spec atual não foi alterada).`,
    ];
    return parts.join('\n');
}

function formatReminderComment({ ticketId, hours, keyword, specLocation }) {
    return `[Watcher] Lembrete: a sugestão de spec gerada por IA para o ticket #${ticketId} aguarda revisão há mais de ${hours}h ` +
        `— o ciclo continua pausado.\n\nResponda '${keyword}' pra usar a sugestão do comentário anterior, "aceito" pra seguir ` +
        `sem ela, ou atualize a spec em ${specLocation}. Este lembrete não se repete.`;
}

module.exports = {
    repairSpec, mergeDraft, formatDraftFile, formatRepairComment, formatReminderComment, formatDiff,
    resolveSections, parseGenerated, buildSystemPrompt, buildUserPrompt, childEnv, runClaudeCli,
    PLACEHOLDER, DEFAULT_TIMEOUT_MS, resolveTimeoutMs, isPlaceholderOnly, DRAFT_MARKER,
};
