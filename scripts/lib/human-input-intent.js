// Interpretação da mensagem humana antes de destravar uma task "blocked".
//
// Task blocked não é despachada (dispatchTicket), e o human-input.md só era consumido
// no despacho, então a resposta do dev pelo dashboard ficava parada pra sempre (achado
// ao vivo no #43703: "liberado espaço, pode seguir" ignorado por tick após tick). Mas
// destravar com qualquer mensagem também é perigoso: "vou liberar o disco depois",
// "por que travou?" ou "aceita a suíte focada" não querem dizer a mesma coisa. Então,
// antes de mexer no status, um `claude -p` curto (sem ferramentas, saída validada por
// --json-schema) lê o bloqueio + a mensagem e devolve a intenção. Só retoma com
// intenção "resume", nó válido e confiança >= limiar; senão a task continua blocked e
// a paráfrase/pergunta volta pro dev (dashboard + Redmine), sem consumir a mensagem —
// a próxima mensagem dele é interpretada junto com a anterior e com a pergunta feita.
//
// Este módulo não sabe de watcher/state.json: monta prompt, roda o CLI, valida e decide.
const { execFile: nodeExecFile } = require('child_process');
const crypto = require('crypto');
const os = require('os');

const DEFAULT_MODEL = 'claude-sonnet-5-5';
const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000;
const DEFAULT_MIN_CONFIDENCE = 0.8;
const INTENTS = ['resume', 'hold', 'unclear'];
// commit pode ser pedido: o watcher grava node=commit e para em NEVER_AUTO_DISPATCH/
// revisão humana como sempre — nunca dispara o /commit por causa da mensagem.
const RESUMABLE_NODES = ['plan', 'implement', 'review', 'test', 'verify', 'commit'];
const MAX_CONTEXT_CHARS = 4000;
// O que cada nó faz — pro intérprete escolher onde retomar quando o pedido é trabalho
// que o nó travado não faz (ex.: /verify só confere; ajuste na spec pedido pelo dev só cabe antes do /plan selar o hash).
const NODE_ROLES = {
    plan: 'diagnóstico e plano (plan.md) a partir da spec; ajuste na spec pedido pelo desenvolvedor (ex.: numerar os critérios como AC-NN) só entra aqui, antes de o plan selar o spec_hash',
    implement: 'altera o código conforme o plano',
    review: 'revisão estática do diff (spec compliance + engenharia)',
    test: 'escreve/roda testes e monta a matriz de evidência dos ACs',
    verify: 'só confere evidências e aceite final; não muda spec, plano nem código',
    commit: 'commit/PR (nunca disparado automaticamente)',
};

const RESPONSE_SCHEMA = {
    type: 'object',
    properties: {
        intent: { type: 'string', enum: INTENTS },
        node: { type: 'string', enum: RESUMABLE_NODES },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        understood: { type: 'string' },
        instructions: { type: 'string' },
        question: { type: 'string' },
    },
    required: ['intent', 'node', 'confidence', 'understood', 'instructions', 'question'],
    additionalProperties: false,
};

function envNumber(value, fallback, { min = 0, max = Infinity } = {}) {
    const n = Number(value);
    return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

function resolveConfig(env = process.env) {
    return {
        model: (env.HUMAN_INPUT_INTERPRETER_MODEL || '').trim() || DEFAULT_MODEL,
        timeoutMs: Math.floor(envNumber(env.HUMAN_INPUT_INTERPRETER_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, { min: 1 })),
        minConfidence: envNumber(env.HUMAN_INPUT_MIN_CONFIDENCE, DEFAULT_MIN_CONFIDENCE, { max: 1 }),
    };
}

// Assinatura do que está pendente: mesma mensagem não é reinterpretada a cada tick.
function messageHash(message) {
    return crypto.createHash('sha256').update(String(message ?? '').trim()).digest('hex').slice(0, 16);
}

const tail = (text, max = MAX_CONTEXT_CHARS) => {
    const s = String(text ?? '').trim();
    return s.length > max ? `…${s.slice(-max)}` : s;
};

/**
 * @param {object} p
 * @param {string} p.message      conteúdo pendente do human-input.md (pode ter várias mensagens)
 * @param {string} p.node         nó em que a task travou
 * @param {string} [p.status]     blocked | escalated | spec-change-rejected
 * @param {string[]} [p.history]  nós já executados
 * @param {string} [p.blockedReason] state.blocked_reason
 * @param {string} [p.agentNote]  última nota do agente (agent_log)
 * @param {string} [p.handoff]    handoff.md (só o final entra no prompt)
 * @param {object} [p.previous]   última interpretação que NÃO destravou ({understood, question})
 */
function buildPrompt({ message, status = 'blocked', node, history = [], blockedReason, agentNote, handoff, previous }) {
    const section = (title, body) => (body ? `\n## ${title}\n${tail(body)}\n` : '');
    return (
        'Você é o orquestrador de um pipeline de desenvolvimento (nós: plan → implement → review → test → verify → commit). ' +
        `Uma task parou com status "${status}" no nó "${node}" e o desenvolvedor respondeu pelo dashboard. ` +
        'Sua única tarefa é entender o que ele pediu e decidir se a task deve ser retomada. Não execute nada.\n' +
        section('Por que a task travou (blocked_reason)', blockedReason) +
        `\n## O que cada nó faz\n${Object.entries(NODE_ROLES).map(([n, r]) => `- ${n}: ${r}`).join('\n')}\n` +
        section('Última nota do agente', agentNote) +
        section('Final do handoff.md (pode conter as opções oferecidas ao desenvolvedor)', handoff) +
        (previous
            ? section('Sua interpretação anterior, que NÃO destravou a task',
                `Entendido: ${previous.understood || '(nada)'}\nPergunta feita ao desenvolvedor: ${previous.question || '(nenhuma)'}`)
            : '') +
        `\n## Nós já executados\n${history.join(' → ') || '(nenhum)'}\n` +
        `\n## Mensagem(ns) do desenvolvedor (mais antiga primeiro)\n${String(message).trim()}\n` +
        '\n## Como responder\n' +
        '- intent "resume": SÓ se a mensagem autoriza explicitamente continuar (ex.: "pode seguir", "resolvi, roda de novo", ' +
        '"aceito a suíte focada, vai pro verify", ou "sim" confirmando a sua pergunta anterior). Uma instrução de ' +
        'trabalho que resolve o motivo da parada (ex.: "pode numerar os critérios", "corrige X") também autoriza seguir.\n' +
        `- node: em que nó retomar. Padrão: o nó em que travou ("${node}"). Outro nó se o desenvolvedor pedir isso ` +
        '(ex.: escolher uma opção do handoff que leva a outro nó, ou "volta pro implement") OU se o trabalho pedido ' +
        'não é feito pelo nó em que travou: escolha o nó mais adiantado do fluxo que faz esse trabalho (veja "O que cada nó faz"); ' +
        'os nós seguintes rodam de novo depois dele.\n' +
        '- intent "hold": ele pede para esperar, diz que ainda vai fazer algo, faz uma pergunta, ou recusa seguir.\n' +
        '- intent "unclear": dá pra ler de mais de um jeito (ex.: não diz qual das opções oferecidas escolheu).\n' +
        '- confidence: 0 a 1, quão seguro você está da intent E do node. Na dúvida, seja conservador.\n' +
        '- understood: paráfrase curta, em português, do que você entendeu — o desenvolvedor vai ler isto.\n' +
        '- instructions: o que o agente do próximo nó deve levar em conta (vazio se nada além de retomar).\n' +
        '- question: se intent não for "resume" (ou confidence baixa), UMA pergunta objetiva em português que, ' +
        'respondida, permite decidir. Vazio caso contrário.\n'
    );
}

function claudeArgs(prompt, model) {
    return [
        '-p', prompt,
        '--output-format', 'json',
        '--model', model,
        '--tools', '',
        '--strict-mcp-config',
        '--no-session-persistence',
        '--json-schema', JSON.stringify(RESPONSE_SCHEMA),
    ];
}

const str = v => (typeof v === 'string' ? v.trim() : '');

// Saída do `claude -p --output-format json` -> interpretação validada, ou null.
function parseOutput(stdout) {
    let doc;
    try { doc = JSON.parse(String(stdout).trim()); } catch { return null; }
    if (!doc || doc.is_error) return null;
    let out = doc.structured_output;
    if (!out && typeof doc.result === 'string') {
        try { out = JSON.parse(doc.result); } catch { return null; }
    }
    if (!out || !INTENTS.includes(out.intent)) return null;
    const confidence = Number(out.confidence);
    return {
        intent: out.intent,
        node: RESUMABLE_NODES.includes(out.node) ? out.node : null,
        confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0,
        understood: str(out.understood),
        instructions: str(out.instructions),
        question: str(out.question),
        cost_usd: Number.isFinite(doc.total_cost_usd) ? doc.total_cost_usd : null,
    };
}

/**
 * Regra de decisão — é aqui, não no modelo, que fica a palavra final.
 * @returns {{ action: 'resume'|'hold'|'ask', node?: string, reply: string }}
 */
function decide(interp, { minConfidence = DEFAULT_MIN_CONFIDENCE } = {}) {
    interp = { ...interp, understood: interp.understood.replace(/[.\s]+$/, '') };
    if (interp.intent === 'resume' && interp.node && interp.confidence >= minConfidence) {
        return { action: 'resume', node: interp.node, reply: `Entendi: ${interp.understood || 'pode seguir'}. Retomando em /${interp.node}.` };
    }
    const understood = interp.understood ? `Entendi: ${interp.understood}. ` : '';
    if (interp.intent === 'resume') {
        // Parece "pode seguir", mas sem segurança suficiente: pede confirmação em vez de chutar.
        const question = interp.question || `Confirma que é pra retomar em /${interp.node || '?'}?`;
        return { action: 'ask', node: interp.node, reply: `${understood}${question} (a task continua parada até você confirmar)` };
    }
    if (interp.intent === 'hold') {
        return { action: 'hold', reply: `${understood}A task continua parada.${interp.question ? ` ${interp.question}` : ''}` };
    }
    return { action: 'ask', reply: `${understood}${interp.question || 'Não ficou claro o que fazer — pode detalhar?'} (a task continua parada)` };
}

/**
 * Roda o intérprete. Nunca lança: falha (CLI ausente, timeout, saída inválida) volta
 * { ok: false, error } e quem chama deixa a task como está, tentando no próximo tick.
 */
function interpret(input, { env = process.env, execFile = nodeExecFile, bin = 'claude', cwd = os.tmpdir(), config = resolveConfig(env) } = {}) {
    const prompt = buildPrompt(input);
    return new Promise(resolve => {
        let child;
        try {
            child = execFile(bin, claudeArgs(prompt, config.model), { cwd, env, timeout: config.timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
                const interp = parseOutput(stdout || '');
                if (interp) return resolve({ ok: true, interpretation: interp, model: config.model });
                resolve({ ok: false, error: err ? (err.killed ? `timeout de ${config.timeoutMs}ms` : err.message) : 'saída do intérprete inválida' });
            });
        } catch (e) {
            return resolve({ ok: false, error: e.message });
        }
        try { child?.stdin?.end(); } catch { /* sem stdin */ }
    });
}

module.exports = {
    buildPrompt, claudeArgs, parseOutput, decide, interpret, messageHash, resolveConfig,
    RESPONSE_SCHEMA, RESUMABLE_NODES, DEFAULT_MODEL, DEFAULT_TIMEOUT_MS, DEFAULT_MIN_CONFIDENCE,
};
