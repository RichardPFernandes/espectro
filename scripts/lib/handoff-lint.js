'use strict';
// PRI-353 (T4; AC4): handoff das fases em esforço alto. O raciocínio não passa para o próximo
// turno, então a fase grava no `plan.md` quatro campos: plano, decisões, riscos e arquivos afetados.
// SPEC: tasks/effort-por-fase/SPEC.md (D7: só avisa na v1, nunca bloqueia).
//
// Dois usos, ambos atrás de WATCHER_PHASE_EFFORT (desligada = nada muda no despacho):
//   - handoffNote(): trecho acrescentado ao extraNote do despacho (instrução de gravar `## Decisões`);
//   - lintHandoff(): validador puro; a CLI imprime o que falta e sempre sai 0.
// Não edita `.claude/commands/*` (plan-scorer e consumidores já leem esses templates).

const fs = require('fs');
const { parseSections, stripComments } = require('./spec-validator');

const HANDOFF_FIELDS = ['plano', 'decisoes', 'riscos', 'arquivos'];

// Título como o usuário lê, para o aviso.
const LABEL = {
    plano: '## Plano de execução',
    decisoes: '## Decisões',
    riscos: '## Riscos técnicos',
    arquivos: '`Arquivo:` nos passos (ou `## Arquivos afetados`)',
};
const HEADING = {
    plano: /^(plano de execucao|passos|etapas)\b/,
    decisoes: /^decisoes\b/,
    riscos: /^riscos tecnicos\b/,
    arquivos: /^arquivos afetados\b/,
};
// Fases em esforço alto que escrevem o plan.md (review usa review_results, fora desta fatia).
const PLAN_WRITERS = new Set(['plan', 'implement']);
const FILE_LINE = /^\s*[-*]\s*Arquivos?\s*:\s*\S/im;

function hasContent(body) {
    return body.some(l => l.trim() !== '');
}

function lintHandoff(content) {
    const text = typeof content === 'string' ? content : '';
    const sections = parseSections(stripComments(text.replace(/\r\n?/g, '\n')).split('\n')).filter(s => s.level >= 2);
    const body = field => sections.filter(s => HEADING[field].test(s.normalized));
    const missing = [];

    const plano = body('plano');
    if (!plano.some(s => s.body.some(l => /^\s*(\d+[.)]|[-*])\s+\S/.test(l)))) missing.push('plano');
    if (!body('decisoes').some(s => hasContent(s.body))) missing.push('decisoes');
    if (!body('riscos').some(s => hasContent(s.body))) missing.push('riscos');
    const filesInSteps = plano.some(s => FILE_LINE.test(s.body.join('\n')));
    if (!filesInSteps && !body('arquivos').some(s => hasContent(s.body))) missing.push('arquivos');

    return {
        ok: missing.length === 0,
        missing,
        warnings: missing.map(f => `Handoff sem ${f === 'decisoes' ? 'Decisões' : f}: falta ${LABEL[f]} no plan.md.`),
    };
}

// Instrução do despacho. Flag desligada = '' sem tocar na tabela (extraNote idêntico ao AS-IS).
// Só nó em esforço alto na tabela que escreve o plan.md recebe a instrução.
function handoffNote({ nodes, enabled, table, prismaRoot = '$PRISMA_ROOT' }) {
    if (!enabled) return '';
    if (!table) throw new Error('PHASE_EFFORT_TABLE_REQUIRED');
    const writes = (Array.isArray(nodes) ? nodes : []).filter(n => PLAN_WRITERS.has(n) && table[n] === 'high');
    if (!writes.length) return '';
    return (
        'Handoff desta fase (esforço alto): o raciocínio não passa para o próximo turno, então grave-o no ' +
        'memory/runs/<task-id>/plan.md. Além de "## Plano de execução", "## Cobertura dos ACs" e "## Riscos técnicos", ' +
        'inclua a seção "## Decisões" (antes de "## Cobertura dos ACs") com cada escolha de HOW tomada e o porquê, uma por ' +
        'linha; sem decisão a registrar, escreva "- Nenhuma decisão além do plano.". Os arquivos afetados já vão em cada passo ' +
        '("Arquivo:"). Isto não muda o WHAT: a spec segue sendo a autoridade dos ACs. Antes de terminar, rode ' +
        `\`node ${prismaRoot}/scripts/lib/handoff-lint.js memory/runs/<task-id>/plan.md\`: ele só avisa o que falta, ` +
        'nunca bloqueia; complete o que faltar e siga.'
    );
}

module.exports = { lintHandoff, handoffNote, HANDOFF_FIELDS, PLAN_WRITERS };

if (require.main === module) {
    const file = process.argv[2];
    if (!file || !fs.existsSync(file)) {
        console.log(`handoff-lint: arquivo não encontrado${file ? ` (${file})` : ''}. Só aviso: nada foi bloqueado.`);
    } else {
        const r = lintHandoff(fs.readFileSync(file, 'utf8'));
        if (r.ok) console.log('handoff-lint: handoff completo (plano, decisões, riscos e arquivos afetados).');
        else {
            console.log(`handoff-lint: ${r.missing.length} campo(s) ausente(s) em ${file}. Só aviso: nada foi bloqueado.`);
            for (const w of r.warnings) console.log(`  - ${w}`);
        }
    }
    process.exit(0);
}
