'use strict';
// Ligações entre specs vivas (docs/capacidades), ADRs (docs/adr) e SPECs de fatia com
// front-matter (tasks/**, docs/historico/**). A fonte são os campos do cabeçalho; a seção
// "## Ligações" ao fim de cada página é gerada deles. CLI: scripts/knowledge-links.js.
const fs = require('node:fs');
const path = require('node:path');
const { readFields } = require('./front-matter');

const CLI = 'node scripts/knowledge-links.js';
const BEGIN = '<!-- ligacoes:inicio -->';
const END = '<!-- ligacoes:fim -->';
const STATUSES = ['proposta', 'aceita', 'rejeitada', 'obsoleta', 'substituída'];
// Para cada tipo de página, o campo e o tipo de página que ele cita.
const REFS = {
    cap: { depende_de: 'cap', adrs: 'adr' },
    adr: { capacidades: 'cap', substitui: 'adr', substituida_por: 'adr' },
    spec: { capacidades: 'cap', adrs: 'adr' },
};
// Campos que precisam do espelho na outra página: [tipo, campo, tipo do outro, campo do outro].
const MIRRORS = [['cap', 'adrs', 'adr', 'capacidades'], ['adr', 'capacidades', 'cap', 'adrs'], ['adr', 'substitui', 'adr', 'substituida_por'], ['adr', 'substituida_por', 'adr', 'substitui']];

const list = value => (value == null ? [] : Array.isArray(value) ? value : [value]);
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const fix = rel => `Corrija o cabeçalho de ${rel} e rode ${CLI} --check`;

function header(rel, text) {
    try {
        return readFields(text);
    } catch (error) {
        throw new Error(`${rel}: ${error.message}`, { cause: error });
    }
}

function markdownIn(root, dir) {
    if (!fs.existsSync(path.join(root, dir))) return [];
    return fs.readdirSync(path.join(root, dir)).filter(name => name.endsWith('.md')).sort().map(name => `${dir}/${name}`);
}

function specsIn(root, dir) {
    if (!fs.existsSync(path.join(root, dir))) return [];
    return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) return specsIn(root, rel);
        return /^SPEC.*\.md$/.test(entry.name) ? [rel] : [];
    });
}

// Lê as páginas e devolve { pages, problems } com os problemas de cabeçalho das ADRs.
function load(root) {
    const pages = [];
    const problems = [];
    for (const rel of markdownIn(root, 'docs/capacidades').filter(file => !file.endsWith('/README.md'))) {
        const text = read(root, rel);
        const fields = header(rel, text);
        pages.push({ kind: 'cap', rel, text, id: fields.id || path.basename(rel, '.md'), depende_de: list(fields.depende_de), adrs: list(fields.adrs) });
    }
    for (const rel of markdownIn(root, 'docs/adr').filter(file => !/\/(README|modelo)\.md$/.test(file))) {
        const text = read(root, rel);
        const bad = message => problems.push({ rule: 'adr-invalida', message: `${rel}: ${message}. ${fix(rel)}` });
        const num = /^(\d{4})-/.exec(path.basename(rel))?.[1];
        if (!num) { bad('o nome do arquivo deve começar com NNNN-'); continue; }
        if (!text.startsWith('---')) { bad('sem front-matter (id, capacidades, status)'); continue; }
        const id = `ADR-${num}`;
        const fields = header(rel, text);
        for (const key of ['id', 'capacidades', 'status']) if (fields[key] == null) bad(`campo obrigatório ausente: ${key}`);
        if (fields.id != null && fields.id !== id) bad(`id "${fields.id}" difere do prefixo do nome do arquivo (${id})`);
        const adr = { kind: 'adr', rel, text, id, capacidades: list(fields.capacidades), substitui: list(fields.substitui), substituida_por: list(fields.substituida_por) };
        if (fields.status != null && !STATUSES.includes(fields.status)) bad(`status "${fields.status}" fora do MADR (${STATUSES.join(', ')})`);
        if (fields.status === 'substituída' && !adr.substituida_por.length) bad('status substituída sem substituida_por');
        if (adr.substituida_por.length && fields.status !== 'substituída') bad(`substituida_por preenchido com status "${fields.status}"; use substituída`);
        adr.title = /^# (?:ADR \d+: )?(.+)$/m.exec(text)?.[1] || '';
        pages.push(adr);
    }
    for (const rel of [...specsIn(root, 'tasks'), ...specsIn(root, 'docs/historico')]) {
        const text = read(root, rel);
        if (!text.startsWith('---')) continue;
        const fields = header(rel, text);
        pages.push({ kind: 'spec', rel, text, capacidades: list(fields.capacidades), adrs: list(fields.adrs) });
    }
    return { pages, problems };
}

// Regras 1 a 3: IDs, lados e cabeçalho de ADR.
function referenceProblems(pages, problems) {
    const byId = new Map(pages.filter(page => page.id).map(page => [`${page.kind}:${page.id}`, page]));
    const add = (rule, message) => problems.push({ rule, message });
    for (const page of pages) {
        for (const [field, kind] of Object.entries(REFS[page.kind])) {
            for (const id of page[field]) {
                if (!byId.has(`${kind}:${id}`)) add('id-inexistente', `${page.rel}: o campo ${field} cita "${id}", que não existe. ${fix(page.rel)}`);
            }
        }
    }
    for (const [kind, field, otherKind, otherField] of MIRRORS) {
        for (const page of pages.filter(p => p.kind === kind)) {
            for (const id of page[field]) {
                const other = byId.get(`${otherKind}:${id}`);
                if (other && !other[otherField].includes(page.id)) {
                    add('lados-divergem', `${page.rel}: ${field} cita ${id}, mas ${other.rel} não cita ${page.id} em ${otherField}. Acrescente em um dos dois cabeçalhos e rode ${CLI} --check`);
                }
            }
        }
    }
    return { problems, byId };
}

// Texto esperado da seção de uma página, ou null se a página não tem ligação.
function expectedSection(page, pages, byId) {
    const ids = values => [...new Set(values)].sort();
    const linked = (kind, id) => pages.filter(p => p.kind === kind && id(p));
    const groups = {
        cap: () => [['Depende de', 'cap', page.depende_de], ['Usada por', 'cap', linked('cap', p => p.depende_de.includes(page.id)).map(p => p.id)],
            ['ADRs', 'adr', [...page.adrs, ...linked('adr', p => p.capacidades.includes(page.id)).map(p => p.id)]]],
        adr: () => [['Capacidades', 'cap', page.capacidades], ['Substitui', 'adr', page.substitui], ['Substituída por', 'adr', page.substituida_por]],
        spec: () => [['Capacidades', 'cap', page.capacidades], ['ADRs', 'adr', page.adrs]],
    }[page.kind]();
    const lines = groups.flatMap(([label, kind, values]) => ids(values).map(id => [label, id, byId.get(`${kind}:${id}`)]))
        .filter(([, , target]) => target)
        .map(([label, id, target]) => {
            const link = `[${id}](${path.posix.relative(path.posix.dirname(page.rel), target.rel)})`;
            return `- ${label}: ${link}${target.kind === 'adr' && target.title ? ` — ${target.title}` : ''}`;
        });
    return lines.length ? `${BEGIN}\n## Ligações\n\n${lines.join('\n')}\n${END}` : null;
}

// Tira a seção existente (com a linha em branco antes) e, se houver `section`, acrescenta ao fim.
function applySection(text, section) {
    const begin = text.indexOf(BEGIN);
    const end = text.indexOf(END);
    if ((begin === -1) !== (end === -1) || end < begin) throw new Error(`faltam os marcadores ${BEGIN} e ${END}, nesta ordem`);
    let base = text;
    if (begin !== -1) {
        const after = text.slice(end + END.length);
        const head = text.slice(0, begin);
        base = (head.endsWith('\n\n') ? head.slice(0, -1) : head) + (after.trim() === '' ? '' : after.replace(/^\n/, ''));
    }
    return section ? `${base}${base.endsWith('\n') ? '' : '\n'}\n${section}\n` : base;
}

function analyze(root) {
    const { pages, problems } = load(root);
    const { byId } = referenceProblems(pages, problems);
    return { pages, problems, next: page => applySection(page.text, expectedSection(page, pages, byId)) };
}

// Confere as quatro regras e devolve { total, problems: [{ rule, message }] }.
function check(root) {
    const { pages, problems, next } = analyze(root);
    for (const page of pages) {
        let expected;
        try {
            expected = next(page);
        } catch (error) {
            problems.push({ rule: 'secao', message: `${page.rel}: ${error.message}. Corrija os marcadores e rode ${CLI} --write` });
            continue;
        }
        if (expected !== page.text) {
            problems.push({ rule: 'secao', message: `${page.rel}: a seção "Ligações" está ausente ou diferente da esperada (ou existe em página sem ligação). Rode ${CLI} --write e inclua o arquivo no commit` });
        }
    }
    return { total: pages.length, problems };
}

// Regenera as seções. Se IDs ou lados falharem, devolve os problemas sem escrever nada.
function write(root) {
    const { pages, problems, next } = analyze(root);
    if (problems.length) return { problems, changed: [] };
    const changed = pages.filter(page => next(page) !== page.text);
    for (const page of changed) fs.writeFileSync(path.join(root, page.rel), next(page));
    return { problems: [], changed: changed.map(page => page.rel) };
}

function summary({ total, problems }) {
    if (!problems.length) return `ligações: ${total} páginas, sem problema`;
    const count = rule => problems.filter(problem => problem.rule === rule).length;
    return `ligações: ${total} páginas; IDs inexistentes: ${count('id-inexistente')}; lados divergentes: ${count('lados-divergem')}; ADRs inválidas: ${count('adr-invalida')}; seções defasadas: ${count('secao')}`;
}

module.exports = { check, write, summary, applySection };
