// Validador do mapa de entrega: ROADMAP.md (raiz) + roadmap/fase-N-<nome>/FASE.md.
// Só lê arquivos. As colunas das tabelas são achadas pelo NOME do cabeçalho ("ID",
// "Depende de", "Status"), nunca pela posição: coluna nova não quebra o validador.
//
// Erros (exit 1):
//   R1 ID de fatia único, no padrão F<fase>.<n>, com a fase igual à da pasta fase-<N>-…
//   R2 fatia citada em "Depende de" existe ("Fase 1" e texto livre são ignorados)
//   R3 dependência não aponta para fase posterior; não há ciclo. Exceção: a fila
//      condicional (Fase 6) não passa pela checagem de fase, só pela de ciclo
//   R4 "Status" pertence a STATUS_VOCAB (regra 8 de roadmap/README.md); aceita detalhe
//      depois do termo: "removida em 2026-11-20: motivo", "ligada (15/11)"
//   R5 link markdown relativo em ROADMAP.md e roadmap/**/*.md aponta para algo que existe
//   R6 fase da tabela do ROADMAP.md tem pasta e FASE.md; toda pasta fase-* está no ROADMAP.md
//   R7 decisão (D<n>) citada numa linha de fatia existe em roadmap/DECISOES.md
//   R8 pasta tasks/f<fase>-<n>-<slug>/ corresponde a uma fatia do mapa
// Avisos (não mudam o exit): R2 para dependência de fatia `removida` e para menção solta
// (fora de "Depende de") a fatia que não existe; R1 para FASE.md sem tabela de fatias.
//
// CLI: node scripts/lib/roadmap-lint.js [raiz-do-repo]   (uma linha por achado)

const fs = require('fs');
const path = require('path');

const STATUS_VOCAB = ['não iniciada', 'em spec', 'em andamento', 'ligada', 'concluída', 'removida'];
const CONDITIONAL_PHASE = 6;
const SLICE_ID = /^F(\d+)\.(\d+)$/;
const SLICE_REF = /\bF\d+\.\d+\b/g;
const DECISION_REF = /\bD\d+\b/g;
const LINK = /\[[^\]]*\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g;

const plain = s => String(s || '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_~`]/g, '').trim();
const norm = s => plain(s).toLowerCase().replace(/\s+/g, ' ');

/** Tabelas markdown do texto: [{headers (normalizados), rows: [{cells, line}]}]. */
function parseTables(text) {
    const tables = [];
    let current = null;
    noCodeBlocks(text).forEach((line, idx) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('|')) { current = null; return; }
        const cells = trimmed.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(c => c.trim());
        if (!current) {
            current = { headers: cells.map(norm), rows: [] };
            tables.push(current);
        } else if (!cells.every(c => /^:?-+:?$/.test(c))) {
            current.rows.push({ cells, line: idx + 1 });
        }
    });
    return tables;
}

// Linhas do texto com o conteúdo de blocos cercados apagado (mantém a numeração).
function noCodeBlocks(text) {
    let fenced = false;
    return text.split(/\r?\n/).map(line => {
        const fence = /^\s*(```|~~~)/.test(line);
        if (fence) fenced = !fenced;
        return fence || fenced ? '' : line;
    });
}

/** Fatias de um FASE.md: tabelas com coluna "ID" e ("Depende de" ou "Status"). */
function parseSlices(text, file) {
    const phase = Number((/(?:^|\/)fase-(\d+)-/.exec(file) || [])[1]);
    const slices = [];
    for (const table of parseTables(text)) {
        const iId = table.headers.indexOf('id');
        const iDep = table.headers.findIndex(h => h.startsWith('depende de'));
        const iStatus = table.headers.findIndex(h => h.startsWith('status'));
        if (iId < 0 || (iDep < 0 && iStatus < 0)) continue;
        for (const { cells, line } of table.rows) {
            slices.push({
                id: plain(cells[iId]), file, line, phase,
                deps: iDep < 0 ? [] : [...new Set(plain(cells[iDep]).match(SLICE_REF) || [])],
                status: iStatus < 0 ? null : norm(cells[iStatus]),
                decisions: [...new Set(cells.join(' ').match(DECISION_REF) || [])],
            });
        }
    }
    return slices;
}

function statusOk(status) {
    return STATUS_VOCAB.some(term => status === term
        || (status.startsWith(term) && /^(\s*[(:;,—–-]|\s+em\s+\d)/.test(status.slice(term.length))));
}

function listDirs(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort();
}

function markdownFiles(root, rel) {
    return fs.readdirSync(path.join(root, rel), { withFileTypes: true }).flatMap(e => {
        const child = `${rel}/${e.name}`;
        if (e.isDirectory()) return markdownFiles(root, child);
        return e.name.endsWith('.md') ? [child] : [];
    }).sort();
}

/** Valida o roadmap sob `root`. @returns {Array<{level, rule, file, id, message}>} */
function lint(root) {
    const findings = [];
    const add = (level, rule, file, id, message) => findings.push({ level, rule, file, id, message });
    const exists = rel => fs.existsSync(path.join(root, rel));
    const read = rel => (exists(rel) ? fs.readFileSync(path.join(root, rel), 'utf8') : '');
    const isPhase = name => /^fase-\d+-/.test(name);
    const phaseDirs = [
        ...listDirs(path.join(root, 'roadmap')).filter(isPhase).map(d => `roadmap/${d}`),
        ...listDirs(path.join(root, 'roadmap', 'arquivo')).filter(isPhase).map(d => `roadmap/arquivo/${d}`),
    ];
    const roadmap = read('ROADMAP.md');
    const docs = [...(exists('ROADMAP.md') ? ['ROADMAP.md'] : []), ...(exists('roadmap') ? markdownFiles(root, 'roadmap') : [])];
    if (!exists('ROADMAP.md')) add('erro', 'R6', 'ROADMAP.md', '-', 'ROADMAP.md não existe na raiz');

    // R6: tabela de fases × pastas.
    const phaseNumbers = new Set(phaseDirs.map(d => Number(/fase-(\d+)-/.exec(d)[1])));
    for (const table of parseTables(roadmap)) {
        const iFase = table.headers.indexOf('fase');
        for (const { cells } of iFase < 0 ? [] : table.rows) {
            const num = /^(\d+)\b/.exec(plain(cells[iFase]));
            if (num && !phaseNumbers.has(Number(num[1]))) add('erro', 'R6', 'ROADMAP.md', `Fase ${num[1]}`, `fase listada sem pasta roadmap/fase-${num[1]}-<nome>/; crie a pasta com FASE.md ou tire a linha`);
        }
    }
    const slices = [];
    for (const dir of phaseDirs) {
        const file = `${dir}/FASE.md`;
        if (!exists(file)) add('erro', 'R6', dir, '-', 'pasta de fase sem FASE.md');
        if (!roadmap.includes(`${dir}/`)) add('erro', 'R6', dir, '-', 'pasta de fase não aparece no ROADMAP.md; acrescente a linha com link na tabela de fases');
        const found = parseSlices(read(file), file);
        if (exists(file) && !found.length) add('aviso', 'R1', file, '-', 'nenhuma tabela de fatias (colunas "ID" e "Depende de" ou "Status")');
        slices.push(...found);
    }

    // R1: IDs.
    const byId = new Map();
    for (const s of slices) {
        const m = SLICE_ID.exec(s.id);
        if (!m) add('erro', 'R1', s.file, s.id || `linha ${s.line}`, 'ID fora do padrão F<fase>.<n>');
        else if (Number(m[1]) !== s.phase) add('erro', 'R1', s.file, s.id, `ID da fase ${m[1]} dentro da pasta da fase ${s.phase}; IDs não mudam de fase`);
        else if (byId.has(s.id)) add('erro', 'R1', s.file, s.id, `ID duplicado (já usado em ${byId.get(s.id).file}:${byId.get(s.id).line}); use o próximo número livre`);
        else byId.set(s.id, s);
    }

    // R2, R3 (fase), R4, R7.
    const decisions = new Set(parseTables(read('roadmap/DECISOES.md'))
        .flatMap(t => (t.headers.indexOf('id') < 0 ? [] : t.rows.map(r => plain(r.cells[t.headers.indexOf('id')])))));
    const missing = new Set();
    for (const s of byId.values()) {
        for (const dep of s.deps) {
            const target = byId.get(dep);
            if (!target) { missing.add(dep); add('erro', 'R2', s.file, s.id, `depende de ${dep}, que não existe no roadmap`); continue; }
            if (target.phase > s.phase && s.phase !== CONDITIONAL_PHASE) add('erro', 'R3', s.file, s.id, `depende de ${dep}, de fase posterior (${target.phase} > ${s.phase})`);
            if ((target.status || '').startsWith('removida')) add('aviso', 'R2', s.file, s.id, `depende de ${dep}, que está removida`);
        }
        if (s.status === null) add('erro', 'R4', s.file, s.id, 'tabela de fatias sem coluna "Status"');
        else if (!statusOk(s.status)) add('erro', 'R4', s.file, s.id, `status "${s.status}" fora do vocabulário (${STATUS_VOCAB.join(', ')})`);
        for (const d of s.decisions.filter(d => !decisions.has(d))) add('erro', 'R7', s.file, s.id, `cita ${d}, que não é linha de roadmap/DECISOES.md`);
    }

    // R3: ciclo (busca em profundidade; cada ciclo é relatado uma vez).
    const state = new Map();
    const visit = (id, trail) => {
        if (state.get(id) === 'done') return;
        if (state.get(id) === 'open') {
            add('erro', 'R3', byId.get(id).file, id, `ciclo de dependência: ${[...trail.slice(trail.indexOf(id)), id].join(' → ')}`);
            return;
        }
        state.set(id, 'open');
        for (const dep of byId.get(id).deps) if (byId.has(dep)) visit(dep, [...trail, id]);
        state.set(id, 'done');
    };
    for (const id of byId.keys()) visit(id, []);

    // R5 e menções soltas (aviso R2).
    for (const file of docs) {
        const text = read(file);
        for (const [, target] of noCodeBlocks(text).join('\n').replace(/`[^`\n]*`/g, '').matchAll(LINK)) {
            const bare = target.split('#')[0];
            if (!bare || /^(https?:|mailto:)/i.test(target)) continue;
            const rel = bare.startsWith('/') ? bare.slice(1) : path.posix.join(path.posix.dirname(file), decodeURIComponent(bare));
            if (!exists(rel)) add('erro', 'R5', file, '-', `link quebrado: (${target}) não existe`);
        }
        for (const ref of new Set(text.match(SLICE_REF) || [])) {
            if (!byId.has(ref) && !missing.has(ref)) add('aviso', 'R2', file, ref, 'menção a fatia que não existe no roadmap');
        }
    }

    // R8: pasta de trabalho da fatia.
    for (const dir of listDirs(path.join(root, 'tasks'))) {
        const m = /^f(\d+)-(\d+)(?:-|$)/.exec(dir);
        if (m && !byId.has(`F${m[1]}.${m[2]}`)) add('erro', 'R8', `tasks/${dir}`, `F${m[1]}.${m[2]}`, 'pasta de fatia sem linha no roadmap; corrija o nome ou acrescente a fatia ao FASE.md');
    }
    return findings;
}

const format = f => `${f.level} ${f.rule} ${f.file} ${f.id}: ${f.message}`;

if (require.main === module) {
    const findings = lint(path.resolve(process.argv[2] || path.join(__dirname, '..', '..')));
    findings.forEach(f => console.log(format(f)));
    const errors = findings.filter(f => f.level === 'erro').length;
    console.log(`roadmap-lint: ${errors} erro(s), ${findings.length - errors} aviso(s)`);
    process.exit(errors ? 1 : 0);
}

module.exports = { STATUS_VOCAB, CONDITIONAL_PHASE, parseTables, parseSlices, statusOk, lint, format };
