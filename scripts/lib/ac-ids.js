// IDs estáveis dos Critérios de Aceite (AC-01, AC-02, ...). A spec é a autoridade
// sobre O QUE entregar: cada critério tem um ID que o Plan, o state.json
// (`ac_ids`) e o registro de ACs (.graph/ac-registry.json) citam — o texto do
// critério vive só na spec.
//
// Formato de um critério na seção "## Critérios de Aceite":
//   - AC-01: Ao selecionar "Remessa", devem ser exibidos só registros do tipo Remessa.
// Aceita `**AC-01**:`/`**AC-01:**`, separador ":" ou "—"/"-", checkbox "[ ]" antes.
// Só itens de lista do nível mais raso contam como critério; sub-itens indentados
// (detalhe, nota de correção datada do /commit) são continuação do critério de cima.
//
// Sem dependência de spec-validator (que importa este módulo): as funções recebem as
// linhas do corpo da seção já recortada.
//
// Uso como CLI (normalização explícita na entrada de um ciclo novo — /fetch-ticket):
//   node scripts/lib/ac-ids.js number <spec.md> [--write]
//   Numera os critérios sem ID continuando depois do maior ID existente (nunca
//   renumera um ID já dado). Sem --write só imprime a spec resultante.
//   exit 0 = ok (ou nada a numerar), 1 = seção com ID malformado/duplicado (não mexe;
//   corrija à mão), 2 = uso incorreto/arquivo inexistente/sem seção de critérios.

const fs = require('fs');
const path = require('path');

const AC_ID_RE = /^AC-(\d+)$/;
const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;
const CHECKBOX = /^\[[ xX]\]\s*/;
// ID canônico no início do item, com ou sem negrito/crase, seguido de separador.
const CANONICAL_PREFIX = /^[*_`]*(AC-(\d+))[*_`]*\s*(?:[:—–-][*_`]*\s*|$)/;
// Algo que PARECE um ID de critério mas fora do padrão: "AC1:", "ac-01:", "AC 1 -",
// "AC_01:", "AC-01 texto" (sem separador), "A-1:", "CA-1:". "A"/"CA" só com hífen e
// separador explícito — "A 2ª via do boleto..." é texto, não ID.
const IDISH_PREFIX = /^[*_`]*(?:(AC[\s_#.-]*\d+)[*_`]*(?=\s*[:—–)-]|\s|$)|((?:A|CA)-\d+)[*_`]*(?=\s*[:—–)]))/i;

function canonicalId(n) {
    return `AC-${String(n).padStart(2, '0')}`;
}

function idNumber(id) {
    const m = AC_ID_RE.exec(String(id || '').trim());
    return m ? Number(m[1]) : null;
}

function stripItemMarkup(text) {
    return String(text || '').replace(CHECKBOX, '').trim();
}

// Itens de lista do nível mais raso: [{raw, line, text}]. Linhas mais indentadas
// (e linhas sem marcador logo abaixo) entram no texto do item; linha em branco não
// encerra (critério longo costuma ter sub-bullets separados por linha vazia).
function topLevelItems(bodyLines) {
    const indents = bodyLines.map(l => LIST_ITEM.exec(l)).filter(Boolean).map(m => m[1].length);
    if (!indents.length) return [];
    const top = Math.min(...indents);
    const items = [];
    bodyLines.forEach((line, idx) => {
        const m = LIST_ITEM.exec(line);
        if (m && m[1].length === top) {
            items.push({ line: idx, head: stripItemMarkup(m[2]), extra: [] });
            return;
        }
        if (items.length && line.trim()) items[items.length - 1].extra.push(line.trim());
    });
    return items;
}

/**
 * Lê os critérios da seção (só o corpo, linhas já sem comentário HTML).
 * @returns {{items: Array<{id: string|null, num: number|null, text: string, raw: string,
 *   line: number, malformed: string|null}>, hasIds: boolean}}
 *   hasIds=true se ALGUM item começa com algo que parece ID (válido ou não) — a
 *   partir daí a seção inteira é tratada como "com IDs" e validada por inteiro.
 */
function parseAcItems(bodyLines) {
    const items = topLevelItems(bodyLines).map(it => {
        const canon = CANONICAL_PREFIX.exec(it.head);
        if (canon) {
            const own = it.head.slice(canon[0].length).replace(/^[*_`]+/, '');
            const text = [own, ...it.extra].join(' ').replace(/\s+/g, ' ').trim();
            return { id: canon[1], num: Number(canon[2]), text, raw: it.head, line: it.line, malformed: null };
        }
        const idish = IDISH_PREFIX.exec(it.head);
        const text = [it.head, ...it.extra].join(' ').replace(/\s+/g, ' ').trim();
        return { id: null, num: null, text, raw: it.head, line: it.line, malformed: idish ? (idish[1] || idish[2]) : null };
    });
    return { hasIds: items.some(i => i.id || i.malformed), items };
}

/**
 * Valida os IDs da seção. Só chame com hasIds=true (seção sem nenhum ID é decisão de
 * política de quem chama — ver spec-validator, opção acIds).
 * @returns {Array<{code: string, message: string}>}
 */
function validateAcItems(items) {
    const errors = [];
    const seen = new Map();
    items.forEach((it, idx) => {
        const pos = `item ${idx + 1} ("${short(it.raw)}")`;
        if (it.malformed) {
            errors.push({
                code: 'AC_ID_INVALID_FORMAT',
                message: AC_ID_RE.test(it.malformed)
                    ? `Critério de aceite ${it.malformed} sem ":" entre o ID e o texto no ${pos} — use "${it.malformed}: <critério>".`
                    : `Critério de aceite com ID fora do padrão "${it.malformed}" no ${pos} — use AC-01, AC-02... (maiúsculo, hífen, número).`,
            });
            return;
        }
        if (!it.id) {
            errors.push({ code: 'AC_ID_MISSING', message: `Critério de aceite sem ID no ${pos} — quando a seção usa IDs, todo critério precisa de um (AC-XX).` });
            return;
        }
        if (!it.text) {
            errors.push({ code: 'AC_EMPTY_TEXT', message: `${it.id} está sem texto — todo critério precisa descrever o que o QA vai verificar.` });
        }
        if (seen.has(it.num)) {
            errors.push({ code: 'AC_ID_DUPLICATE', message: `${it.id} duplicado (já usado por ${seen.get(it.num)}) — cada critério precisa de um ID único.` });
            return;
        }
        seen.set(it.num, it.id);
    });
    const nums = [...seen.keys()];
    if (nums.length) {
        const max = Math.max(...nums);
        const missing = [];
        for (let n = 1; n <= max; n++) if (!seen.has(n)) missing.push(canonicalId(n));
        if (missing.length) {
            errors.push({ code: 'AC_ID_SEQUENCE_GAP', message: `Sequência de IDs dos critérios com lacuna: falta(m) ${missing.join(', ')} — os IDs vão de AC-01 a AC-${String(max).padStart(2, '0')} sem pular. Critério que deixou de valer não é apagado: mantenha o ID com "(removido em <data>: motivo)".` });
        }
        const sorted = [...nums].sort((a, b) => a - b);
        if (!missing.length && nums.some((n, i) => n !== sorted[i])) {
            errors.push({ code: 'AC_ID_OUT_OF_ORDER', message: `Critérios fora de ordem (${nums.map(canonicalId).join(', ')}) — liste de AC-01 em diante.` });
        }
    }
    return errors;
}

function short(text, max = 60) {
    const t = String(text).replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Numera os critérios sem ID de um corpo de seção (linhas), continuando depois do
 * maior ID existente. Não mexe em item com ID malformado — devolve `blocked`.
 * @returns {{lines: string[], assigned: string[], blocked: string[]}}
 */
function assignAcIds(bodyLines) {
    const { items } = parseAcItems(bodyLines);
    const blocked = items.filter(i => i.malformed).map(i => i.malformed);
    const nums = items.filter(i => i.num != null).map(i => i.num);
    if (blocked.length || new Set(nums).size !== nums.length) {
        return { lines: [...bodyLines], assigned: [], blocked: blocked.length ? blocked : ['IDs duplicados'] };
    }
    let next = nums.length ? Math.max(...nums) + 1 : 1;
    const lines = [...bodyLines];
    const assigned = [];
    for (const it of items) {
        if (it.id) continue;
        const id = canonicalId(next++);
        const m = LIST_ITEM.exec(lines[it.line]);
        const marker = lines[it.line].slice(m[1].length).match(/^(?:[-*+]|\d+[.)])/)[0];
        const cb = CHECKBOX.exec(m[2]);
        lines[it.line] = `${m[1]}${marker} ${cb ? cb[0] : ''}${id}: ${stripItemMarkup(m[2])}`;
        assigned.push(id);
    }
    return { lines, assigned, blocked: [] };
}

// Numera os critérios de um texto que É o corpo da seção (ex: subseção "Critérios"
// extraída da descrição do ticket pelo spec-generator).
function numberCriteriaText(text) {
    const src = String(text || '');
    if (!src.trim()) return src;
    const { lines, blocked } = assignAcIds(src.split('\n'));
    return blocked.length ? src : lines.join('\n');
}

// Critério que deixou de valer mantém o ID (estabilidade) com "(removido em <data>:
// motivo)" — continua na sequência, mas não é aplicável à execução.
function isRemovedCriterion(text) {
    return /^[(\[]?\s*removido\b/i.test(String(text || '').trim());
}

/** Referências AC-XX num texto (plano, handoff) — números, sem repetição, na ordem. */
function findAcRefs(text) {
    const out = [];
    for (const m of String(text || '').matchAll(/\bAC-(\d+)\b/g)) {
        const n = Number(m[1]);
        if (!out.includes(n)) out.push(n);
    }
    return out;
}

module.exports = {
    parseAcItems, validateAcItems, assignAcIds, numberCriteriaText, findAcRefs, isRemovedCriterion,
    canonicalId, idNumber, AC_ID_RE,
};

if (require.main === module) {
    const [cmd, file] = process.argv.slice(2).filter(a => !a.startsWith('--'));
    if (cmd !== 'number' || !file || !fs.existsSync(file)) {
        console.error('Uso: node scripts/lib/ac-ids.js number <spec.md> [--write]');
        process.exit(2);
    }
    // Import tardio: spec-validator importa este módulo.
    const { parseSections, parseHeading, normalizeHeading } = require('./spec-validator');
    const content = fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');
    const lines = content.split('\n');
    // Comentários HTML viram espaço (mesmos índices de linha): só as linhas de item são
    // reescritas, por índice — o resto da spec sai byte a byte igual.
    const masked = content.replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, ' ')).split('\n');
    const isAcHeading = l => { const h = parseHeading(l); return !!h && /^criterios? de aceit/.test(normalizeHeading(h.text)); };
    const headingIdx = masked.findIndex(isAcHeading);
    const section = headingIdx === -1 ? null : parseSections(masked).find(s => /^criterios? de aceit/.test(s.normalized));
    if (!section) {
        console.error(`${file}: sem seção "## Critérios de Aceite".`);
        process.exit(2);
    }
    const start = headingIdx + 1;
    const body = section.body;
    const { lines: numbered, assigned, blocked } = assignAcIds(body);
    if (blocked.length) {
        console.error(`${file}: não numerei — corrija antes: ${blocked.join(', ')}.`);
        process.exit(1);
    }
    numbered.forEach((l, i) => { if (l !== body[i]) lines[start + i] = l; });
    const out = lines.join('\n');
    if (process.argv.includes('--write')) {
        if (assigned.length) fs.writeFileSync(file, out);
        console.log(assigned.length ? `${file}: IDs atribuídos ${assigned.join(', ')}.` : `${file}: todos os critérios já têm ID.`);
        // Numerar texto legado não é origem do critério: provenance UNKNOWN/ORIGIN
        // "legacy-numbering" (docs/ac-provenance.md). Falha aqui não desfaz a numeração.
        const ticket = (/^(\d+)-spec\.md$/.exec(path.basename(file)) || [])[1];
        if (assigned.length && ticket) {
            try {
                const acProvenance = require('./ac-provenance');
                const r = acProvenance.appendEvents(ticket, acProvenance.legacyNumberingEvents(ticket, assigned),
                    { root: acProvenance.provenanceRoot(path.dirname(path.resolve(file))) });
                if (!r.ok) console.error(`[ac-provenance] não registrada: ${r.errors.join('; ')}`);
            } catch (e) {
                console.error(`[ac-provenance] não registrada: ${e.message}`);
            }
        }
    } else {
        process.stdout.write(out);
    }
}
