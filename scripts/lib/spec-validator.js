// Portão de qualidade da spec, antes de qualquer despacho de agente pro Plan.
// Spec incompleta (principalmente sem Critérios de Aceite) propaga garbage-in por
// plan → implement → review → test — ver templates/spec-template.md pro formato que
// esta validação espera, e scripts/readmine-watcher.js (runTicketSpecGate/runTaskSpecGate) pra onde ela
// bloqueia o ciclo.
//
// Casamento de cabeçalho é deliberadamente tolerante na FORMA (não no conteúdo):
// aceita níveis 1-4 de Markdown (`##`, `###` — descrições do Redmine usam `###`) e
// Textile (`h2.`), ignora caixa e acento, aceita singular/plural e sufixo (ex:
// "### Critérios de Aceite (QA)", "### Solução esperada", "## Critério de aceite").
// Sem isso o portão reprovaria tickets bem escritos só por formatação.
//
// IDs dos Critérios de Aceite (AC-01, AC-02... — ver scripts/lib/ac-ids.js): se a
// seção tiver QUALQUER ID, todos são validados (formato AC-\d+, únicos, sequência sem
// lacuna, texto não vazio) e erro de ID é sempre erro. A opção `acIds` só decide o que
// fazer quando a seção NÃO tem nenhum ID:
//   'optional' (padrão da função) — nada. É o modo da descrição crua do Redmine, que
//              nunca traz IDs (quem numera é o /fetch-ticket) e não pode reprovar por isso.
//   'require'  — erro AC_IDS_MISSING. Spec de ciclo novo (depois do /fetch-ticket).
//   'legacy'   — aviso AC_IDS_MISSING_LEGACY. Spec de run anterior aos IDs
//              (isLegacyAcRun) — histórico não quebra nem é reescrito.
// O validador nunca corrige a spec: só reporta.
//
// Template versionado (templates/spec.md.template, ver scripts/lib/spec-template.js):
// spec com `spec_template_version` no frontmatter segue as regras do template, mais
// estritas na forma — cabeçalho EXATO de nível 2 para ## Contexto, ## Objetivo,
// ## Escopo e ## Critérios de Aceite (MISSING_REQUIRED_SECTION), seção obrigatória só
// com o comentário de instrução (SECTION_NOT_FILLED), nenhum "- AC-NN:" nos critérios
// (NO_ACCEPTANCE_CRITERIA) e comentário de instrução do template ainda presente
// (TEMPLATE_COMMENTS_PRESENT). Sem a chave, a spec é legada (anterior ao template): as
// regras acima deste comentário continuam valendo e, com `templateVersion: 'warn'`,
// sai o aviso SPEC_TEMPLATE_VERSION_MISSING — nunca erro (specs antigas não migram).
// O padrão da função é 'ignore' porque ela também valida a descrição crua do Redmine,
// que nunca tem frontmatter; o CLI avisa.
//
// [PENDING_CLARIFICATION] num critério (qualquer formato): a spec é aceita (aviso
// PENDING_CLARIFICATION, IDs em result.pendingClarification), mas o /plan não roda até
// o marcador sair — quem bloqueia é o portão do watcher (runTaskSpecGate) e o próprio
// /plan, não o veredito `valid`.
//
// Uso como CLI: node scripts/lib/spec-validator.js <arquivo> [--json] [--legacy | --ac-ids=optional]
//                 [--state <state.json>]
//   Padrão do CLI = 'require' (é o que o /fetch-ticket roda na spec que acabou de
//   escrever); --legacy = spec de run anterior (sem IDs vira aviso, não erro).
//   --state grava spec_template_version (do frontmatter) no state.json do run.
//   exit 0 = válida, 1 = inválida, 2 = uso incorreto/arquivo inexistente.

const fs = require('fs');
const crypto = require('crypto');
const { normalizeHeading, parseHeading, stripComments } = require('./spec-headings');
const acIdsLib = require('./ac-ids');
const specTemplate = require('./spec-template');

const MIN_CONTENT_CHARS = 200;
const MIN_ACCEPTANCE_ITEMS = 2;
const AC_ID_POLICIES = ['optional', 'require', 'legacy'];
// Runs iniciados antes disto, sem `ac_ids` no state.json, são de antes dos IDs AC-XX.
const AC_IDS_REQUIRED_SINCE = '2026-10-01T00:00:00.000Z';

// `match` roda contra o texto do cabeçalho normalizado (minúsculo, sem acento).
const REQUIRED_SECTIONS = [
    {
        key: 'criterios_aceite',
        label: '## Critérios de Aceite',
        heading: 'Critérios de Aceite',
        match: /^criterios? de aceit/,
        hint: 'Liste em tópicos, um critério por linha com ID estável ("- AC-01: ...", "- AC-02: ..."), como o QA vai verificar que a entrega está correta — no mínimo 2 critérios.',
    },
    {
        key: 'problema_contexto',
        label: '## Problema (ou ## Contexto)',
        heading: 'Problema',
        match: /^(problema|contexto)\b/,
        hint: 'Descreva a situação atual: o que acontece hoje, quem é afetado e por que precisa mudar.',
    },
    {
        key: 'solucao',
        label: '## Solução',
        heading: 'Solução',
        match: /^solucao\b/,
        hint: 'Descreva o comportamento esperado depois da entrega (o quê, não necessariamente o como).',
    },
];

const RECOMMENDED_SECTIONS = [
    {
        key: 'restricoes',
        label: '## Restrições',
        match: /^restric/,
        hint: 'O que NÃO pode mudar ou quebrar (telas, integrações, regras de negócio, clientes específicos).',
    },
    {
        key: 'arquivos_afetados',
        label: '## Arquivos Afetados',
        match: /^arquivos afetados\b/,
        hint: 'Telas, endpoints, módulos ou arquivos que você já sabe que serão tocados.',
    },
    {
        key: 'dependencias',
        label: '## Dependências',
        match: /^dependencias?\b/,
        hint: 'Outros tickets, repositórios configurados pelo consumidor, dados ou acessos necessários.',
    },
];

// Seções do template versionado (v1): cabeçalho exato, nível 2.
const TEMPLATE_REQUIRED_SECTIONS = [
    { key: 'contexto', heading: 'Contexto', hint: 'Descreva o problema: situação atual, quem é afetado e por que precisa mudar (ver docs/spec-guide.md).' },
    { key: 'objetivo', heading: 'Objetivo', hint: 'Diga como saber que a entrega deu certo — o critério de sucesso, não a implementação.' },
    { key: 'escopo', heading: 'Escopo', hint: 'Liste o que entra e o que NÃO entra nesta entrega.' },
    { key: 'criterios_aceite', heading: 'Critérios de Aceite', hint: 'Um critério verificável por linha: "- AC-01: Ao <ação>, o sistema <resultado observável>".' },
];
const TEMPLATE_OPTIONAL_SECTIONS = ['Dependências Técnicas', 'Restrições', 'Referências'];
const PENDING_CLARIFICATION_MARKER = '[PENDING_CLARIFICATION]';
const TEMPLATE_VERSION_POLICIES = ['ignore', 'warn'];

// Quebra a spec em seções: cada cabeçalho reconhecido vira {heading, level, body[]},
// com corpo indo até o próximo cabeçalho de nível igual ou superior.
function parseSections(lines) {
    const headings = [];
    lines.forEach((line, idx) => {
        const h = parseHeading(line);
        if (h) headings.push({ ...h, idx });
    });
    return headings.map((h, i) => {
        let end = lines.length;
        for (let j = i + 1; j < headings.length; j++) {
            if (headings[j].level <= h.level) { end = headings[j].idx; break; }
        }
        return {
            heading: h.text,
            normalized: normalizeHeading(h.text),
            level: h.level,
            body: lines.slice(h.idx + 1, end),
        };
    });
}

function findSection(sections, def) {
    return sections.find(s => def.match.test(s.normalized)) || null;
}

// Além de "-"/"*" (pedido original), conta lista numerada ("1.", "1)") — specs
// geradas pelo fetch_ticket e tickets reais usam esse formato pra critérios bem
// escritos, e reprová-los seria falso negativo de formatação.
function countListItems(bodyLines) {
    return bodyLines.filter(l => /^\s*(?:[-*]|\d+[.)])\s+\S/.test(l)).length;
}

function hasText(bodyLines) {
    return bodyLines.some(l => l.trim() && !parseHeading(l));
}

/**
 * Run de antes dos IDs AC-XX: state.json sem `ac_ids` e iniciado antes de
 * AC_IDS_REQUIRED_SINCE (sem data = histórico). Run com `ac_ids` (mesmo []) nasceu no
 * formato novo. Replay e ciclo novo ganham started_at novo — entram exigindo IDs.
 */
function isLegacyAcRun(state) {
    if (!state || typeof state !== 'object') return true;
    if (Array.isArray(state.ac_ids)) return false;
    const started = Date.parse(state.started_at || '');
    return !Number.isFinite(started) || started < Date.parse(AC_IDS_REQUIRED_SINCE);
}

/**
 * @typedef {{code: string, section?: string, message: string, hint?: string}} ValidationError
 * @typedef {{code: string, section?: string, message: string, hint?: string}} ValidationWarning
 * @param {string} specContent
 * @param {{acIds?: 'optional'|'require'|'legacy', templateVersion?: 'ignore'|'warn',
 *   templateComments?: Set<string>}} [opts] ver cabeçalho do arquivo. templateVersion só
 *   vale para spec legada; templateComments substitui os comentários do template (testes).
 * @returns {{valid: boolean, errors: ValidationError[], warnings: ValidationWarning[],
 *   missingSections: string[], acIds: string[], pendingClarification: string[],
 *   templateVersion: number|null}}
 *   pendingClarification: IDs (ou "item N") dos critérios com [PENDING_CLARIFICATION] —
 *   não afeta `valid`, mas bloqueia o /plan.
 *   templateVersion: spec_template_version do frontmatter (null = spec legada).
 *   missingSections: `key` (ver REQUIRED_SECTIONS) de cada seção obrigatória ausente, vazia
 *   ou com critérios insuficientes — o que o scripts/lib/spec-repairer.js consegue gerar.
 *   TOO_SHORT e erros de ID não entram (não são seção faltando).
 *   acIds: IDs dos critérios aplicáveis (fora os "(removido em ...)"), como escritos
 *   na spec, na ordem ([] sem IDs).
 */
function validateSpec(specContent, opts = {}) {
    const acIdPolicy = opts.acIds || 'optional';
    if (!AC_ID_POLICIES.includes(acIdPolicy)) throw new Error(`acIds inválido: ${acIdPolicy} (use ${AC_ID_POLICIES.join('|')})`);
    const versionPolicy = opts.templateVersion || 'ignore';
    if (!TEMPLATE_VERSION_POLICIES.includes(versionPolicy)) throw new Error(`templateVersion inválido: ${versionPolicy} (use ${TEMPLATE_VERSION_POLICIES.join('|')})`);
    const templateVersion = specTemplate.templateVersionOf(specContent);
    if (templateVersion !== null) return validateTemplatedSpec(specContent, templateVersion, opts);

    const result = validateLegacySpec(specContent, acIdPolicy);
    if (versionPolicy === 'warn') {
        result.warnings.push({
            code: 'SPEC_TEMPLATE_VERSION_MISSING',
            message: 'Spec sem spec_template_version no frontmatter (anterior ao template canônico) — validada pelas regras legadas.',
            hint: 'Spec nova começa de templates/spec.md.template (node scripts/lib/spec-template.js init); spec antiga não precisa ser migrada.',
        });
    }
    return result;
}

// Critérios com [PENDING_CLARIFICATION]: aviso por critério + IDs (ou "item N" sem ID).
function collectPendingClarification(items, label, warnings) {
    const pending = [];
    items.forEach((it, idx) => {
        if (acIdsLib.isRemovedCriterion(it.text) || !`${it.raw} ${it.text}`.includes(PENDING_CLARIFICATION_MARKER)) return;
        const ref = it.id || `item ${idx + 1}`;
        pending.push(ref);
        warnings.push({
            code: 'PENDING_CLARIFICATION',
            section: label,
            message: `${ref} marcado ${PENDING_CLARIFICATION_MARKER} — aceito na spec, mas o /plan não roda até o esclarecimento.`,
            hint: `Resolva a dúvida, reescreva o critério e remova o marcador ${PENDING_CLARIFICATION_MARKER}.`,
        });
    });
    return pending;
}

// Regras do template versionado — ver comentário do topo. missingSections fica vazio de
// propósito: o auto-repair (spec-repairer.js) só conhece as seções legadas e mesclaria
// "## Problema"/"## Solução" numa spec do template; spec v1 incompleta segue o pedido
// de edição/aceite no Redmine.
function validateTemplatedSpec(specContent, version, opts = {}) {
    const errors = [];
    const warnings = [];
    const acIds = [];
    let pendingClarification = [];
    const raw = String(specContent || '').replace(/\r\n?/g, '\n');
    const result = () => ({
        valid: errors.length === 0, errors, warnings, missingSections: [], acIds, pendingClarification, templateVersion: version,
    });

    if (!specTemplate.SUPPORTED_VERSIONS.includes(version)) {
        errors.push({
            code: 'UNSUPPORTED_TEMPLATE_VERSION',
            message: `spec_template_version inválida ou desconhecida no frontmatter (suportadas: ${specTemplate.SUPPORTED_VERSIONS.join(', ')}).`,
            hint: `Use "spec_template_version: ${specTemplate.SPEC_TEMPLATE_VERSION}" (templates/spec.md.template).`,
        });
        return result();
    }

    // Placeholder {{X}} que sobrou não conta como conteúdo (ex: descrição vazia no ticket).
    const lines = stripComments(raw).replace(/\{\{[A-Z_]+\}\}/g, '').split('\n');
    const sections = parseSections(lines);
    for (const def of TEMPLATE_REQUIRED_SECTIONS) {
        const label = `## ${def.heading}`;
        const section = sections.find(s => s.level === 2 && s.heading.trim() === def.heading);
        if (!section) {
            const near = findSection(sections, { match: new RegExp(`^${normalizeHeading(def.heading)}`) });
            errors.push({
                code: 'MISSING_REQUIRED_SECTION',
                section: label,
                message: `Seção obrigatória ausente: ${label}${near ? ` (achei "${'#'.repeat(near.level)} ${near.heading}" — o cabeçalho precisa ser exatamente "${label}")` : ''}.`,
                hint: def.hint,
            });
            continue;
        }
        if (!hasText(section.body)) {
            errors.push({
                code: 'SECTION_NOT_FILLED',
                section: label,
                message: `Seção obrigatória ${label} não foi preenchida (só tem a instrução do template).`,
                hint: def.hint,
            });
            continue;
        }
        if (def.key !== 'criterios_aceite') continue;
        const parsed = acIdsLib.parseAcItems(section.body);
        if (!parsed.items.some(i => i.id)) {
            errors.push({
                code: 'NO_ACCEPTANCE_CRITERIA',
                section: label,
                message: `${label} não tem nenhum critério no formato "- AC-NN: <critério>".`,
                hint: def.hint,
            });
        }
        if (parsed.hasIds) {
            for (const e of acIdsLib.validateAcItems(parsed.items)) {
                errors.push({ ...e, section: label, hint: 'Formato: "- AC-01: <critério verificável>", IDs de AC-01 em diante sem pular nem repetir.' });
            }
            acIds.push(...parsed.items.filter(i => i.id && !acIdsLib.isRemovedCriterion(i.text)).map(i => i.id));
        }
        pendingClarification = collectPendingClarification(parsed.items, label, warnings);
    }

    // Instrução do template ainda na spec = autor não terminou (ou não revisou) a seção.
    const known = opts.templateComments || specTemplate.templateComments();
    const leftover = [];
    let current = '(início do arquivo)';
    for (const chunk of raw.split(/(<!--[\s\S]*?-->)/)) {
        if (chunk.startsWith('<!--')) {
            if (known.has(specTemplate.normalizeComment(chunk)) && !leftover.includes(current)) leftover.push(current);
            continue;
        }
        for (const line of chunk.split('\n')) {
            const h = parseHeading(line);
            if (h && h.level <= 2) current = `${'#'.repeat(h.level)} ${h.text}`;
        }
    }
    if (leftover.length) {
        errors.push({
            code: 'TEMPLATE_COMMENTS_PRESENT',
            message: `Comentários de instrução do template ainda presentes em: ${leftover.join(', ')}.`,
            hint: 'Preencha a seção e apague o comentário <!-- ... --> do template (seção opcional sem conteúdo: apague a seção inteira).',
        });
    }
    return result();
}

function validateLegacySpec(specContent, acIdPolicy) {
    const acIds = [];
    let pendingClarification = [];
    const errors = [];
    const warnings = [];
    const missingSections = [];
    const content = stripComments(String(specContent || '').replace(/\r\n?/g, '\n'));
    const lines = content.split('\n');
    const sections = parseSections(lines);

    for (const def of REQUIRED_SECTIONS) {
        const section = findSection(sections, def);
        if (!section) {
            errors.push({
                code: 'MISSING_SECTION',
                section: def.label,
                message: `Seção obrigatória ausente: ${def.label}.`,
                hint: def.hint,
            });
            missingSections.push(def.key);
            continue;
        }
        if (def.key === 'criterios_aceite') {
            const parsed = acIdsLib.parseAcItems(section.body);
            // Com IDs, conta critério (item de topo); sem IDs, o comportamento de sempre
            // (qualquer item de lista) — não muda o veredito de spec antiga.
            const items = parsed.hasIds ? parsed.items.length : countListItems(section.body);
            if (items < MIN_ACCEPTANCE_ITEMS) {
                errors.push({
                    code: 'INSUFFICIENT_ACCEPTANCE_CRITERIA',
                    section: def.label,
                    message: `${def.label} tem ${items} ${parsed.hasIds ? 'critério(s)' : 'item(ns) de lista'} — mínimo ${MIN_ACCEPTANCE_ITEMS} (linhas começando com "-", "*" ou "1.").`,
                    hint: def.hint,
                });
                missingSections.push(def.key);
            }
            pendingClarification = collectPendingClarification(parsed.items, def.label, warnings);
            if (parsed.hasIds) {
                for (const e of acIdsLib.validateAcItems(parsed.items)) {
                    errors.push({ ...e, section: def.label, hint: 'Formato: "- AC-01: <critério verificável>", IDs de AC-01 em diante sem pular nem repetir.' });
                }
                acIds.push(...parsed.items.filter(i => i.id && !acIdsLib.isRemovedCriterion(i.text)).map(i => i.id));
            } else if (items > 0 && acIdPolicy !== 'optional') {
                const issue = {
                    section: def.label,
                    hint: 'Numere os critérios como "- AC-01: ...", "- AC-02: ..." (node scripts/lib/ac-ids.js number <spec> --write numera sem mudar o texto).',
                };
                if (acIdPolicy === 'require') {
                    errors.push({ code: 'AC_IDS_MISSING', message: `${def.label} sem IDs estáveis (AC-01, AC-02...) — obrigatório em spec de ciclo novo.`, ...issue });
                } else {
                    warnings.push({ code: 'AC_IDS_MISSING_LEGACY', message: `${def.label} sem IDs AC-XX (spec de run anterior aos IDs — segue, rastreabilidade por ID indisponível).`, ...issue });
                }
            }
        } else if (!hasText(section.body)) {
            errors.push({
                code: 'EMPTY_SECTION',
                section: def.label,
                message: `Seção obrigatória ${def.label} está vazia.`,
                hint: def.hint,
            });
            missingSections.push(def.key);
        }
    }

    const textLength = lines
        .filter(l => !parseHeading(l))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
        .length;
    if (textLength <= MIN_CONTENT_CHARS) {
        errors.push({
            code: 'TOO_SHORT',
            message: `Spec tem ${textLength} caracteres de conteúdo (sem contar cabeçalhos) — precisa de mais de ${MIN_CONTENT_CHARS}.`,
            hint: 'Detalhe o problema, a solução esperada e os critérios de aceite — spec curta demais não dá base pro diagnóstico.',
        });
    }

    for (const def of RECOMMENDED_SECTIONS) {
        if (!findSection(sections, def)) {
            warnings.push({
                code: 'MISSING_RECOMMENDED_SECTION',
                section: def.label,
                message: `Seção recomendada ausente: ${def.label}.`,
                hint: def.hint,
            });
        }
    }

    return { valid: errors.length === 0, errors, warnings, missingSections, acIds, pendingClarification, templateVersion: null };
}

// Identifica "esta spec com estes problemas" — muda se a spec for editada ou se o
// resultado mudar, e é o que evita comentar de novo no Redmine a cada tick.
function specSignature(specContent, result) {
    const h = crypto.createHash('sha1');
    h.update(String(specContent || ''));
    h.update(JSON.stringify(result.errors.map(e => e.code + (e.section || ''))));
    return h.digest('hex');
}

function formatIssue(i) {
    return i.hint ? `- ${i.message} ${i.hint}` : `- ${i.message}`;
}

// Prefixo fixo do comentário de pendência — é por ele que o watcher acha, nos
// journals do ticket, a partir de onde procurar a resposta de aceite.
const REDMINE_COMMENT_PREFIX = '[Watcher] Spec do ticket';

/**
 * Comentário (Markdown do Redmine) listando o que falta na spec e pedindo aceite.
 * Spec incompleta não exige preenchimento: basta responder "aceito" pra seguir.
 * @param {{errors: ValidationError[], warnings: ValidationWarning[]}} result
 * @param {{ticketId: number|string, sourceLabel: string, fixInstruction: string, templateUrl: string}} opts
 */
function formatRedmineComment(result, { ticketId, sourceLabel, fixInstruction, templateUrl }) {
    const parts = [
        `${REDMINE_COMMENT_PREFIX} #${ticketId} está incompleta — o ciclo (plan → implement → review → test) ficou pausado aguardando o seu aceite.`,
        '',
        `Fonte validada: ${sourceLabel}.`,
        '',
        '**Pendências:**',
        ...result.errors.map(formatIssue),
    ];
    if (result.warnings.length) {
        parts.push('', '**Recomendações:**', ...result.warnings.map(formatIssue));
    }
    parts.push(
        '',
        '**Para seguir assim mesmo:** responda este ticket com um comentário começando por "aceito" — não precisa preencher nada. ' +
        'As pendências acima vão como aviso pro diagnóstico do /plan.',
        '',
        `**Ou, se preferir completar:** ${fixInstruction} Template: ${templateUrl}`,
        '',
        'O próximo tick do watcher confere de novo e segue sozinho — não precisa reiniciar nada.',
    );
    return parts.join('\n');
}

// Resposta de aceite num comentário do Redmine: precisa COMEÇAR pela palavra (evita
// falso positivo tipo "não aceito" ou "aceito se incluir X" no meio de um texto).
const ACCEPTANCE_NOTE = /^\s*(aceito|aceite|aceita|de acordo|ok|pode seguir|pode continuar|prosseguir|segue|seguir)\b/i;

function isAcceptanceNote(text) {
    return ACCEPTANCE_NOTE.test(String(text || ''));
}

// Prefixo do comentário do auto-repair (scripts/lib/spec-repairer.js). Não começa por
// "[Watcher]" porque o texto foi pedido assim — quem filtra comentário do watcher
// usa isWatcherNote, não o startsWith direto.
const SPEC_REPAIR_COMMENT_PREFIX = '🤖 Spec incompleta — sugestão gerada automaticamente';

function isWatcherNote(text) {
    const t = String(text || '').trim();
    return t.startsWith('[Watcher]') || t.startsWith(SPEC_REPAIR_COMMENT_PREFIX);
}

// Palavra de aprovação do draft do auto-repair (SPEC_APPROVAL_KEYWORD, padrão
// "aprovado"). Mesma regra do aceite: precisa COMEÇAR pela palavra, sem caixa — "não
// aprovado" ou "aprovado se mudar X" no meio de um texto não contam.
function approvalKeyword(env = process.env) {
    return String(env.SPEC_APPROVAL_KEYWORD || '').trim() || 'aprovado';
}

function isApprovalNote(text, keyword = approvalKeyword()) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^\\s*${escaped}(?![\\p{L}\\p{N}])`, 'iu').test(String(text || ''));
}

// Palavra de rejeição de uma SPEC_CHANGE proposta pelo /implement (SPEC_REJECTION_KEYWORD,
// padrão "rejeitado"; scripts/lib/spec-change.js). Mesma regra da aprovação.
function rejectionKeyword(env = process.env) {
    return String(env.SPEC_REJECTION_KEYWORD || '').trim() || 'rejeitado';
}

function isRejectionNote(text, keyword = rejectionKeyword()) {
    return isApprovalNote(text, keyword);
}

// Comentário de critério pendente de esclarecimento. Diferente do pedido de aceite:
// "aceito" NÃO libera — só a spec sem o marcador libera o /plan.
const PENDING_CLARIFICATION_COMMENT_PREFIX = '[Watcher] Spec com critério pendente de esclarecimento';

function formatPendingClarificationComment(result, { ticketId, specLocation }) {
    return [
        `${PENDING_CLARIFICATION_COMMENT_PREFIX} — ticket #${ticketId}. O /plan fica pausado até o esclarecimento.`,
        '',
        `Spec: ${specLocation}.`,
        '',
        '**Critérios marcados ' + PENDING_CLARIFICATION_MARKER + ':**',
        ...result.warnings.filter(w => w.code === 'PENDING_CLARIFICATION').map(formatIssue),
        '',
        `Responder "aceito" não libera este bloqueio: reescreva o critério na spec e remova o marcador ${PENDING_CLARIFICATION_MARKER}. ` +
        'O próximo tick do watcher confere de novo e segue sozinho.',
    ].join('\n');
}

const CONTEXT_BEGIN = '<!-- spec-validator:avisos:inicio -->';
const CONTEXT_END = '<!-- spec-validator:avisos:fim -->';

// Bloco (com marcadores) pro context.md — marcadores permitem substituir/remover o
// bloco de forma idempotente em ticks seguintes (ver upsertContextWarnings).
function formatContextWarnings(result, { sourceLabel, accepted = false }) {
    const intro = accepted
        ? `Spec incompleta (${sourceLabel}), mas o ciclo seguiu por ACEITE explícito do usuário — ` +
          'as pendências abaixo não precisam ser preenchidas; considere-as no diagnóstico e deixe claro no ' +
          'handoff o que foi assumido por falta de informação:'
        : `Spec aprovada no portão de qualidade (${sourceLabel}), mas com seções recomendadas ausentes — ` +
          'considere isso no diagnóstico e confirme com o solicitante se algo relevante ficou de fora:';
    return [
        CONTEXT_BEGIN,
        '## Avisos da validação de spec',
        '',
        intro,
        '',
        ...result.warnings.map(formatIssue),
        CONTEXT_END,
    ].join('\n');
}

// Insere, substitui ou (sem warnings) remove o bloco de avisos num texto de
// context.md. Retorna o novo texto (igual ao original se nada mudou).
function upsertContextWarnings(existing, rawResult, opts) {
    // Gate gravado pela aprovação do draft do auto-repair não tem errors/warnings.
    const result = { ...rawResult, warnings: rawResult?.warnings || [] };
    const text = existing || '';
    const begin = text.indexOf(CONTEXT_BEGIN);
    const end = begin === -1 ? -1 : text.indexOf(CONTEXT_END, begin);
    const hasBlock = begin !== -1 && end !== -1;
    const block = result.warnings.length ? formatContextWarnings(result, opts) : '';

    if (hasBlock) {
        const before = text.slice(0, begin);
        const after = text.slice(end + CONTEXT_END.length);
        if (!block) return (before.replace(/\n+$/, '\n') + after.replace(/^\n+/, '')).replace(/^\n+/, '');
        return before + block + after;
    }
    if (!block) return text;
    return text ? `${text.replace(/\n*$/, '')}\n\n${block}\n` : `${block}\n`;
}

module.exports = {
    validateSpec, specSignature, formatRedmineComment, formatContextWarnings, upsertContextWarnings,
    REQUIRED_SECTIONS, RECOMMENDED_SECTIONS, MIN_CONTENT_CHARS, MIN_ACCEPTANCE_ITEMS,
    isLegacyAcRun, AC_ID_POLICIES, AC_IDS_REQUIRED_SINCE,
    TEMPLATE_REQUIRED_SECTIONS, TEMPLATE_OPTIONAL_SECTIONS, PENDING_CLARIFICATION_MARKER, TEMPLATE_VERSION_POLICIES,
    formatPendingClarificationComment, PENDING_CLARIFICATION_COMMENT_PREFIX,
    CONTEXT_BEGIN, CONTEXT_END, REDMINE_COMMENT_PREFIX, isAcceptanceNote,
    SPEC_REPAIR_COMMENT_PREFIX, isWatcherNote, approvalKeyword, isApprovalNote, rejectionKeyword, isRejectionNote,
    // Parser de seções, reaproveitado por scripts/lib/ac-registry.js — mesma noção de
    // "onde começa/termina a seção de Critérios de Aceite" que o portão usa.
    parseSections, parseHeading, normalizeHeading, stripComments, findSection, countListItems, hasText,
};

if (require.main === module) {
    const cliArgs = process.argv.slice(2);
    const file = cliArgs.find((a, i) => !a.startsWith('--') && cliArgs[i - 1] !== '--state');
    const policyFlag = (process.argv.find(a => a.startsWith('--ac-ids=')) || '').split('=')[1];
    const acIds = process.argv.includes('--legacy') ? 'legacy' : (policyFlag || 'require');
    if (!file || !fs.existsSync(file) || !AC_ID_POLICIES.includes(acIds)) {
        console.error('Uso: node scripts/lib/spec-validator.js <arquivo-da-spec> [--json] [--legacy | --ac-ids=optional|require|legacy] [--state <state.json>]');
        process.exit(2);
    }
    const stateFile = (() => { const i = process.argv.indexOf('--state'); return i !== -1 ? process.argv[i + 1] : null; })();
    if (stateFile !== null && (!stateFile || !fs.existsSync(stateFile))) {
        console.error(`--state: arquivo inexistente (${stateFile || 'vazio'}).`);
        process.exit(2);
    }
    const result = validateSpec(fs.readFileSync(file, 'utf8'), { acIds, templateVersion: 'warn' });
    if (stateFile && Number.isInteger(result.templateVersion)) {
        specTemplate.recordTemplateVersion(stateFile, result.templateVersion);
    }
    if (process.argv.includes('--json')) {
        console.log(JSON.stringify(result, null, 2));
    } else {
        console.log(result.valid ? `Spec válida: ${file}` : `Spec INVÁLIDA: ${file}`);
        for (const e of result.errors) console.log(`  [erro] ${e.message}`);
        for (const w of result.warnings) console.log(`  [aviso] ${w.message}`);
    }
    process.exit(result.valid ? 0 : 1);
}
