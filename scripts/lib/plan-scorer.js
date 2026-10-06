// Portão de qualidade do plano, entre plan e implement. Plano vago despachado pro
// Implement vira implement errado e ciclos de re-implement caros; este score dá um
// critério objetivo pra mandar o plano de volta ANTES disso — ver
// scripts/readmine-watcher.js (runPlanGate) pra onde ele decide re-plan/escalada.
//
// Só heurística sobre texto — NUNCA chama LLM (restrição do ticket: o portão tem que
// ser barato e determinístico, rodando a cada tick).
//
// O que é "o plano": a seção "## Plano de execução" (ou "## Passos"/"## Etapas") que
// .claude/commands/plan.md manda escrever no handoff.md — lista numerada, um item
// por passo, cada um com "Arquivo:" e "Verificação:". Cinco critérios, 20 pts cada:
//   1. quantidade de passos entre 3 e 10 (binário)
//   2. passos com arquivo afetado (proporcional)
//   3. passos com critério de verificação (proporcional)
//   4. nenhum passo contradiz uma proibição de "## Restrições" da spec (binário)
//   5. passos cobrem os Critérios de Aceite da spec (proporcional)
//
// Critério 5 tem dois modos. Spec com IDs (AC-01, AC-02... — scripts/lib/ac-ids.js):
// rastreabilidade por ID — cada passo diz "Critérios: AC-01, AC-02" e o score reporta
//   - AC da spec sem nenhum passo que o cite;
//   - passo citando AC que não existe na spec (o Plan define COMO, nunca cria
//     critério — a spec é a autoridade sobre O QUÊ);
//   - passo que muda comportamento visível ao usuário (saída de endpoint, UI, regra de
//     validação, filtro, ordenação, persistência) sem AC associado.
// Pontos = 20 × (ACs cobertos / ACs) × (passos sem problema / passos). Resultado traz
// `acTrace` com o detalhe. Spec legada (sem IDs): heurística de sempre — cita "AC<n>"/
// "critério <n>" pelo índice ou metade dos radicais do texto do critério.
//
// Uso como CLI: node scripts/lib/plan-scorer.js <handoff.md> <spec.md> [--json]
//   exit 0 = passou, 1 = abaixo do threshold, 2 = uso incorreto/arquivo inexistente.

const fs = require('fs');
const crypto = require('crypto');
const { parseSections, stripComments } = require('./spec-validator');
const { extractACs } = require('./ac-registry');
const acIdsLib = require('./ac-ids');

const DEFAULT_THRESHOLD = 60;
const MIN_STEPS = 3;
const MAX_STEPS = 10;
const POINTS = 20;

// Cabeçalho normalizado (minúsculo, sem acento — ver spec-validator.normalizeHeading).
const PLAN_HEADING = /^(plano( de (execucao|implementacao|acao))?|passos|etapas( de execucao)?|steps)\b/;
// Fallback pra handoffs escritos antes da seção existir: a lista de pendências.
const FALLBACK_HEADING = /^trabalho pendente\b/;
const RESTRICTIONS_HEADING = /^restric/;
const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;

// Caminho com diretório e extensão (`app/routes/x.html`), nome de arquivo com
// extensão conhecida (`MontagemCargaService.java`), ou diretório entre crases.
const FILE_RE = new RegExp([
    String.raw`(?:[\w.@-]+\/)+[\w.@-]+\.[a-z0-9]{1,6}\b`,
    String.raw`\b[\w-]+\.(?:java|js|mjs|cjs|ts|tsx|jsx|html|css|scss|less|json|ya?ml|xml|sql|md|properties|sh|py|vue|kt|gradle)\b`,
    '`[^`\\s]*\\/[^`\\s]*`',
].join('|'), 'i');

// Rodam contra texto normalizado (sem acento, minúsculo).
const VERIFY_LABEL = /\b(verificacao|validacao|como verificar|como validar|criterio|teste|testes|aceite)\s*:/;
const VERIFY_WORDS = /\b(verificar|verifica|conferir|confere|validar|valida|testar|teste|testes|assert\w*|mvn|npm test|node --test|junit|esperado|deve (retornar|exibir|mostrar|aparecer|passar|falhar|gravar|ficar)|garantir que)\b/;
const NEGATION = /\b(nao|nunca|sem|jamais|proibido|evitar|nenhum|nenhuma)\b/;
// Passo que menciona a restrição como algo a respeitar não a contradiz.
const COMPLIANCE = /\b(nao|nunca|sem|jamais|evitar|preservar|preserva|manter|mantem|intact\w*|inalterad\w*|respeitar|continua)\b/;

const STOPWORDS = new Set(`
a o as os um uma uns umas de da do das dos em na no nas nos por pela pelo pelas pelos
para pra pro com sem que se ou e ao aos à às é ser foi são está estao isso esse essa este
esta aquele aquela como quando onde qual quais mais menos muito muita todo toda todos todas
ja já so só tambem também ainda entre sobre ate até apos após cada outro outra outros outras
seu sua seus suas dele dela nao não nunca jamais proibido evitar nenhum nenhuma pode podem
deve devem precisa precisam fica ficam ter tem sendo sido vai vao tipo via the and
alterar alteracao mudar mudanca mexer tocar quebrar remover criar usar fazer chamar
adicionar modificar incluir mantido mantida manter deixar qualquer nenhuma apenas somente
`.trim().split(/\s+/).map(w => w.normalize('NFD').replace(/[̀-ͯ]/g, '')));

function normalize(text) {
    return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// Radical grosseiro (6 primeiros chars): "filtros"/"filtro", "configuravel"/"configuracao"
// casam — suficiente pra heurística de cobertura sem stemmer de verdade.
function stems(text, minLen = 4) {
    const out = new Set();
    for (const w of normalize(text).match(/[a-z0-9]+/g) || []) {
        if (w.length < minLen || STOPWORDS.has(w)) continue;
        out.add(w.slice(0, 6));
    }
    return out;
}

function sectionsOf(content) {
    return parseSections(stripComments(String(content || '').replace(/\r\n?/g, '\n')).split('\n'));
}

// Itens de lista de nível mais raso do corpo; linhas mais indentadas (sub-bullets
// "- Arquivo: ...", continuação) entram no texto do item. Linha em branco não encerra
// — plano costuma separar passos longos com linha vazia antes do "Verificação:".
function topLevelItems(bodyLines) {
    const indents = bodyLines.map(l => LIST_ITEM.exec(l)).filter(Boolean).map(m => m[1].length);
    if (!indents.length) return [];
    const top = Math.min(...indents);
    const items = [];
    for (const line of bodyLines) {
        const m = LIST_ITEM.exec(line);
        if (m && m[1].length === top) { items.push(m[2]); continue; }
        if (items.length && line.trim()) items[items.length - 1] += '\n' + line.trim();
    }
    return items.map(i => i.trim()).filter(Boolean);
}

/**
 * @returns {{steps: string[], source: string|null}} source = cabeçalho de onde vieram.
 */
function extractSteps(planContent) {
    const all = sectionsOf(planContent);
    // Nível >= 2 primeiro: o título "# Plano — <task-id>" do plan.md casaria PLAN_HEADING
    // e, sendo nível 1, traria as listas de Referência/Cobertura como se fossem passos.
    const sections = [...all.filter(x => x.level >= 2), ...all.filter(x => x.level < 2)];
    for (const match of [PLAN_HEADING, FALLBACK_HEADING]) {
        for (const s of sections.filter(x => match.test(x.normalized))) {
            const steps = topLevelItems(s.body);
            if (steps.length) return { steps, source: s.heading };
        }
    }
    return { steps: [], source: null };
}

function hasFile(step) {
    return FILE_RE.test(step);
}

function hasVerification(step) {
    const n = normalize(step);
    return VERIFY_LABEL.test(n) || VERIFY_WORDS.test(n);
}

// Só proibições entram ("Não alterar o contrato do endpoint de Zona", "SEM chamada a
// LLM"): o objeto da proibição = palavras depois da negação. Restrição afirmativa
// ("Threshold configurável") não é checável por texto e fica de fora.
function extractProhibitions(specContent) {
    const section = sectionsOf(specContent).find(s => RESTRICTIONS_HEADING.test(s.normalized));
    if (!section) return [];
    const items = topLevelItems(section.body);
    const out = [];
    for (const text of items) {
        const n = normalize(text);
        const neg = NEGATION.exec(n);
        if (!neg) continue;
        const terms = [...stems(n.slice(neg.index + neg[0].length), 3)];
        if (terms.length) out.push({ text: text.replace(/\s+/g, ' ').trim(), terms });
    }
    return out;
}

function contradicts(step, prohibition) {
    const n = normalize(step);
    if (COMPLIANCE.test(n)) return false;
    const have = stems(n, 3);
    const hits = prohibition.terms.filter(t => have.has(t)).length;
    return hits >= Math.max(1, Math.ceil(prohibition.terms.length * 0.6));
}

// AC coberto se algum passo o cita ("AC-02", "AC2", "critério 2") ou se os passos, juntos,
// têm metade dos radicais relevantes do AC.
function acCovered(ac, index, stepsText, stepStems) {
    const n = index + 1;
    if (new RegExp(`\\b(ac|criterio)\\s*[-#]?\\s*0*${n}\\b`).test(normalize(stepsText))) return true;
    const want = [...stems(ac)];
    if (!want.length) return true;
    const hits = want.filter(t => stepStems.has(t)).length;
    return hits >= Math.max(1, Math.ceil(want.length * 0.5));
}

// Comportamento visível ao usuário (texto normalizado do passo, fora das linhas de
// verificação/critérios): saída de endpoint, UI, regra de validação, filtro, ordenação
// ou persistência. Heurística — prefere falso positivo explicável a deixar passar.
const VISIBLE_WORDS = /\b(endpoint|api|rest|resource|controller|response|resposta|retorn\w*|json|payload|contrato|tela|ui|front\w*|html|botao|campo|grid|coluna|listagem|exib\w*|mostr\w*|mensagem|validac\w*|validar|obrigatori\w*|filtr\w*|ordena\w*|ordem|sort\w*|persist\w*|grava\w*|salva\w*|banco|tabela|migration|liquibase|insert|update|delete)\b/;
const VISIBLE_FILES = /(\.(html|css|scss|less|vue|tsx|jsx|sql)\b|(controller|resource|repository|dao|endpoint)\.java\b|\/routes?\/)/i;
// Linhas de metadado do passo que não descrevem a mudança em si.
const META_LINE = /^[-*]?\s*(verificacao|validacao|como verificar|como validar|criterios?|acs?|teste|testes)\s*:/;
// Passo só de teste/revisão: não muda comportamento, não precisa de AC.
const TEST_ONLY = /^(escrever|criar|adicionar|rodar|executar|cobrir|revisar|atualizar)?\s*(os\s+)?(testes?|cobertura|revisao)\b/;
const TEST_FILE = /(test\.java|tests?\.[jt]s|\.test\.[jt]s|\/test\/)/i;

function behaviorText(step) {
    return step.split('\n').map(normalize).filter(l => !META_LINE.test(l.trim())).join('\n');
}

function isVisibleChange(step) {
    const n = behaviorText(step);
    const title = normalize(step.split('\n')[0]).trim();
    const files = step.match(new RegExp(FILE_RE.source, 'gi')) || [];
    if (TEST_ONLY.test(title) || (files.length && files.every(f => TEST_FILE.test(f)))) return false;
    return VISIBLE_WORDS.test(n) || files.some(f => VISIBLE_FILES.test(f));
}

/**
 * Rastreabilidade por ID (spec com AC-XX).
 * @returns {{mode: 'ids', ac_ids: string[], covered: string[], uncovered: string[],
 *   unknownRefs: Array<{step: number, id: string}>, visibleWithoutAc: number[], points: number}}
 */
function traceAcIds(specAcIds, steps, knownAcIds = specAcIds) {
    const byNum = new Map(knownAcIds.map(id => [acIdsLib.idNumber(id), id]));
    const cited = new Set();
    const unknownRefs = [];
    const visibleWithoutAc = [];
    const badSteps = new Set();
    steps.forEach((step, i) => {
        const refs = acIdsLib.findAcRefs(step);
        for (const n of refs) {
            if (byNum.has(n)) cited.add(n);
            else { unknownRefs.push({ step: i + 1, id: acIdsLib.canonicalId(n) }); badSteps.add(i); }
        }
        if (!refs.some(n => byNum.has(n)) && isVisibleChange(step)) { visibleWithoutAc.push(i + 1); badSteps.add(i); }
    });
    const covered = specAcIds.filter(id => cited.has(acIdsLib.idNumber(id)));
    const uncovered = specAcIds.filter(id => !cited.has(acIdsLib.idNumber(id)));
    const coverage = specAcIds.length ? covered.length / specAcIds.length : 1;
    const clean = steps.length ? (steps.length - badSteps.size) / steps.length : 0;
    return { mode: 'ids', ac_ids: specAcIds, covered, uncovered, unknownRefs, visibleWithoutAc, points: POINTS * coverage * clean };
}

function short(text, max = 90) {
    const t = String(text).replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function thresholdFrom(env = process.env) {
    const v = Number(String(env.PLAN_SCORE_THRESHOLD ?? '').trim() || NaN);
    return Number.isFinite(v) && v >= 0 && v <= 100 ? v : DEFAULT_THRESHOLD;
}

/**
 * @param {string} planContent handoff.md (ou context.md) escrito pelo /plan
 * @param {string} specContent memory/spec/<id>-spec.md (ou descrição do ticket)
 * @param {{threshold?: number}} [opts] padrão: PLAN_SCORE_THRESHOLD ou 60
 * @returns {{score: number, feedback: string[], passed: boolean, threshold: number,
 *   steps: number, criteria: {key: string, points: number, max: number}[]}}
 */
function scorePlan(planContent, specContent, opts = {}) {
    const threshold = opts.threshold ?? thresholdFrom();
    const feedback = [];
    const criteria = [];
    const add = (key, points) => criteria.push({ key, points: Math.round(points * 10) / 10, max: POINTS });

    const { steps } = extractSteps(planContent);
    const count = steps.length;

    // 1. Quantidade de passos.
    if (count >= MIN_STEPS && count <= MAX_STEPS) add('steps_count', POINTS);
    else {
        add('steps_count', 0);
        feedback.push(count === 0
            ? 'Plano sem passos: falta a seção "## Plano de execução" com uma lista numerada de passos — steps insuficientes.'
            : count < MIN_STEPS
                ? `Plano com ${count} step${count > 1 ? 's' : ''} — steps insuficientes (esperado entre ${MIN_STEPS} e ${MAX_STEPS}); quebre o trabalho em passos concretos.`
                : `Plano com ${count} steps — acima do máximo de ${MAX_STEPS}; agrupe passos relacionados.`);
    }

    // 2 e 3. Arquivo e verificação por passo.
    const noFile = [];
    const noVerify = [];
    steps.forEach((s, i) => {
        if (!hasFile(s)) noFile.push(i + 1);
        if (!hasVerification(s)) noVerify.push(i + 1);
    });
    add('steps_files', count ? POINTS * (count - noFile.length) / count : 0);
    add('steps_verification', count ? POINTS * (count - noVerify.length) / count : 0);
    for (const n of noFile) feedback.push(`Step ${n} não especifica arquivo a modificar (ex: "Arquivo: app-core/src/.../Service.java").`);
    for (const n of noVerify) feedback.push(`Step ${n} não tem critério de verificação (ex: "Verificação: teste X passa / tela mostra Y").`);

    // 4. Contradição com restrições da spec.
    const conflicts = [];
    for (const p of extractProhibitions(specContent)) {
        steps.forEach((s, i) => { if (contradicts(s, p)) conflicts.push({ step: i + 1, restriction: p.text }); });
    }
    add('no_contradiction', conflicts.length ? 0 : POINTS);
    for (const c of conflicts) feedback.push(`Step ${c.step} parece contradizer a restrição do spec: "${short(c.restriction)}".`);

    // 5. Cobertura dos Critérios de Aceite.
    const { acIds: allAcIds, criteria: acs } = extractACs(specContent || '', 'plan');
    // AC "(removido em ...)" segue existindo (referência não é inválida), mas não é cobrado.
    const specAcIds = allAcIds.filter((id, i) => !acIdsLib.isRemovedCriterion(acs[i]));
    let acTrace;
    if (allAcIds.length) {
        acTrace = traceAcIds(specAcIds, steps, allAcIds);
        add('acs_covered', acTrace.points);
        const valid = allAcIds.join(', ');
        for (const id of acTrace.uncovered) feedback.push(`${id} não é endereçado por nenhum step — cite-o em "Critérios: ${id}" no passo que o atende.`);
        for (const u of acTrace.unknownRefs) feedback.push(`Step ${u.step} referencia ${u.id}, que não existe na Spec (ACs válidos: ${valid}) — o Plan define como implementar, não cria critério; critério novo vai pra spec.`);
        for (const n of acTrace.visibleWithoutAc) feedback.push(`Step ${n} muda comportamento visível ao usuário (endpoint, tela, validação, filtro, ordenação ou persistência) sem AC associado — indique "Critérios: AC-XX" ou tire o passo do escopo.`);
        delete acTrace.points;
    } else {
        const stepsText = steps.join('\n');
        const stepStems = stems(stepsText);
        const uncovered = acs.map((ac, i) => ({ ac, n: i + 1 })).filter(({ ac, n }) => !acCovered(ac, n - 1, stepsText, stepStems));
        add('acs_covered', acs.length ? POINTS * (acs.length - uncovered.length) / acs.length : POINTS);
        for (const u of uncovered) feedback.push(`Critério de aceite ${u.n} não é endereçado por nenhum step: "${short(u.ac)}".`);
        acTrace = { mode: 'legacy', ac_ids: [], uncovered: uncovered.map(u => u.n) };
    }

    const score = Math.round(criteria.reduce((sum, c) => sum + c.points, 0));
    return { score, feedback, passed: score >= threshold, threshold, steps: count, criteria, acTrace };
}

// Identifica o plano avaliado: plano igual não é reavaliado nem recontado como
// tentativa nova (o tick roda de novo com o mesmo handoff.md até o implement sair).
function planSignature(planContent) {
    return crypto.createHash('sha256').update(String(planContent || '')).digest('hex').slice(0, 16);
}

module.exports = {
    scorePlan, extractSteps, extractProhibitions, planSignature, thresholdFrom, isVisibleChange,
    DEFAULT_THRESHOLD, MIN_STEPS, MAX_STEPS,
};

if (require.main === module) {
    const [planFile, specFile] = process.argv.slice(2).filter(a => !a.startsWith('--'));
    if (!planFile || !fs.existsSync(planFile) || (specFile && !fs.existsSync(specFile))) {
        console.error('Uso: node scripts/lib/plan-scorer.js <handoff.md> [spec.md] [--json]');
        process.exit(2);
    }
    const result = scorePlan(fs.readFileSync(planFile, 'utf8'), specFile ? fs.readFileSync(specFile, 'utf8') : '');
    if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
    else {
        console.log(`Score do plano: ${result.score}/100 (mínimo ${result.threshold}) — ${result.passed ? 'passou' : 'REPROVADO'}`);
        for (const f of result.feedback) console.log(`  - ${f}`);
    }
    process.exit(result.passed ? 0 : 1);
}
