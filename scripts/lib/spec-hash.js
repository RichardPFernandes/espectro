// spec_hash contratual — implementação ÚNICA do HASH_SCOPE (.claude/spec-hash-config.json).
// Todo script/nó que precisa do hash de uma spec versionada chama daqui (spec-authority,
// spec-change, spec-version, acceptance-evidence, review-result, ac-registry); ninguém
// reimplementa a extração. Ciclo de vida: docs/spec-versioning.md.
//
// O hash cobre só as seções contratuais da spec (allowlist do escopo), em forma canônica:
//   scope:<id>
//   [<section id>]            ← uma por seção do escopo, na ORDEM DO CONFIG (reordenar
//   <linhas normalizadas>        seções na spec não muda o contrato); seção ausente = vazia
// Fora: frontmatter, comentários HTML, a linha do cabeçalho da seção (renomear
// "Critérios de Aceite" → "Critérios de aceite" não é mudança), subseções excluídas
// (Casos-limite, Pontos a esclarecer...), linhas em branco e espaço repetido/de borda.
// Cabeçalho de seção incluída casado em qualquer nível; seção incluída dentro de outra
// incluída pertence à de fora (não conta duas vezes).
//
// Escopos ficam versionados no config por id: run gravado com um escopo é sempre
// recalculado com ele (state.spec.hash_scope), mesmo depois de `current` mudar.
//
// Uso como CLI:
//   node scripts/lib/spec-hash.js <spec.md> [--scope=<id>] [--canonical] [--fingerprint]
// exit 0 = ok, 2 = uso incorreto / spec ou escopo inexistente.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseHeading, normalizeHeading, stripComments } = require('./spec-headings');

const CONFIG_PATH = path.join(process.env.REPO_PATH || process.cwd(), '.claude', 'spec-hash-config.json');

let cached = null;
function loadConfig(file = path.join(process.env.REPO_PATH || process.cwd(), '.claude', 'spec-hash-config.json')) {
    if (cached && cached.file === file) return cached;
    const config = parseConfig(JSON.parse(fs.readFileSync(file, 'utf8')), file);
    cached = config;
    return config;
}

/**
 * Config já lido (objeto JSON) → forma usada por scopeOf/contractHash. Permite a quem
 * lê o config de um objeto Git (writer SDD, PRI-266) usar a mesma regra sem tocar o disco.
 */
function parseConfig(raw, file = '<memória>') {
    if (!raw || typeof raw !== 'object' || !raw.scopes || !raw.current || !raw.scopes[raw.current]) {
        throw new Error(`${file}: config inválido — precisa de "current" apontando para um id em "scopes"`);
    }
    const scopes = {};
    for (const [id, s] of Object.entries(raw.scopes)) {
        scopes[id] = {
            id,
            include: (s.include_sections || []).map(sec => ({ id: sec.id, headings: sec.headings.map(h => new RegExp(h)) })),
            exclude: (s.exclude_sections || []).map(h => new RegExp(h)),
        };
    }
    return { file, algorithm: raw.algorithm || 'sha256', current: raw.current, scopes };
}

function currentScope(config = loadConfig()) {
    return config.current;
}

function scopeOf(id, config = loadConfig()) {
    const scope = config.scopes[id || config.current];
    if (!scope) throw new Error(`HASH_SCOPE "${id}" não existe em ${path.relative(process.cwd(), config.file)} — escopo usado por um run nunca pode ser removido`);
    return scope;
}

function stripFrontmatter(text) {
    return text.replace(/^---\n[\s\S]*?\n---(?:\n|$)/, '');
}

function normalizeLine(line) {
    return line.replace(/\s+/g, ' ').trim();
}

/**
 * Seções contratuais da spec: { <section id>: string[] (linhas normalizadas, sem vazias) }
 * na ordem do escopo.
 */
function contractSections(specContent, { scope: scopeId, config } = {}) {
    const scope = scopeOf(scopeId, config);
    const text = stripComments(stripFrontmatter(String(specContent || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n')));
    const lines = text.split('\n');
    const headings = [];
    lines.forEach((line, idx) => { const h = parseHeading(line); if (h) headings.push({ ...h, idx, norm: normalizeHeading(h.text) }); });
    const endOf = i => {
        for (let j = i + 1; j < headings.length; j++) if (headings[j].level <= headings[i].level) return headings[j].idx;
        return lines.length;
    };

    const owner = new Array(lines.length).fill(null);
    headings.forEach((h, i) => {
        if (owner[h.idx] !== null) return; // já dentro de seção incluída: pertence à de fora
        const sec = scope.include.find(s => s.headings.some(re => re.test(h.norm)));
        if (!sec) return;
        const end = endOf(i);
        for (let k = h.idx + 1; k < end; k++) owner[k] = sec.id;
        owner[h.idx] = '';  // a linha do cabeçalho não conta
    });
    headings.forEach((h, i) => {
        if (!scope.exclude.some(re => re.test(h.norm))) return;
        const end = endOf(i);
        for (let k = h.idx; k < end; k++) owner[k] = null;
    });

    const out = Object.fromEntries(scope.include.map(s => [s.id, []]));
    lines.forEach((line, i) => {
        if (!owner[i]) return;
        const n = normalizeLine(line);
        if (n) out[owner[i]].push(n);
    });
    return out;
}

/** Texto canônico que é hasheado (útil para depurar "por que o hash mudou"). */
function canonicalContract(specContent, opts = {}) {
    const scope = scopeOf(opts.scope, opts.config);
    const sections = contractSections(specContent, { ...opts, scope: scope.id });
    return [`scope:${scope.id}`, ...Object.entries(sections).flatMap(([id, body]) => [`[${id}]`, ...body])].join('\n') + '\n';
}

function sha256(text) {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** spec_hash contratual (SHA-256 hex, 64 chars). */
function contractHash(specContent, opts = {}) {
    return sha256(canonicalContract(specContent, opts));
}

const AC_LINE = /^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s*)?[*_`]*AC-0*(\d+)(?!\d)[*_`]*/;

/**
 * Impressão digital compacta do contrato: hash curto de cada AC e de cada seção — o que
 * o changelog guarda para gerar diff_summary legível sem copiar a spec.
 * @returns {{acs: Object<string,string>, sections: Object<string,string>}}
 */
function fingerprint(specContent, opts = {}) {
    const sections = contractSections(specContent, opts);
    const acs = {};
    let cur = null;
    for (const line of sections.acceptance_criteria || []) {
        const m = AC_LINE.exec(line);
        if (m) { cur = `AC-${String(Number(m[1])).padStart(2, '0')}`; acs[cur] = [line.slice(m[0].length).replace(/^\s*[:—–-]?\s*/, '')]; continue; }
        if (cur) acs[cur].push(line);
    }
    const short = s => sha256(s).slice(0, 12);
    return {
        acs: Object.fromEntries(Object.entries(acs).map(([id, ls]) => [id, short(ls.join('\n'))])),
        sections: Object.fromEntries(Object.entries(sections).filter(([, b]) => b.length).map(([id, b]) => [id, short(b.join('\n'))])),
        removed: Object.entries(acs).filter(([, ls]) => /\((removid[oa]|cancelad[oa]|descontinuad[oa])\s+em\b/i.test(ls[0] || '')).map(([id]) => id),
    };
}

const SECTION_LABELS = {
    acceptance_criteria: 'Critérios de Aceite', objective: 'Objetivo', scope: 'Escopo',
    business_rules: 'Regras de Negócio', expected_behavior: 'Comportamento Esperado',
    solution: 'Solução', constraints: 'Restrições',
};

/**
 * Resumo legível do que mudou no HASH_SCOPE entre duas impressões digitais
 * ("AC-04 adicionado; AC-02 removido; Escopo alterado"). null se não houver base.
 */
function diffSummary(before, after) {
    if (!before || !after) return null;
    const parts = [];
    const b = before.acs || {};
    const a = after.acs || {};
    const wasRemoved = new Set(before.removed || []);
    for (const id of Object.keys(a)) {
        if (!(id in b)) parts.push(`${id} adicionado`);
        else if ((after.removed || []).includes(id) && !wasRemoved.has(id)) parts.push(`${id} removido`);
        else if (a[id] !== b[id]) parts.push(`${id} reformulado`);
    }
    for (const id of Object.keys(b)) if (!(id in a)) parts.push(`${id} apagado da spec`);
    const bs = before.sections || {};
    const as = after.sections || {};
    for (const id of new Set([...Object.keys(bs), ...Object.keys(as)])) {
        if (id === 'acceptance_criteria' || bs[id] === as[id]) continue;
        const label = SECTION_LABELS[id] || id;
        parts.push(!(id in bs) ? `${label} adicionada` : !(id in as) ? `${label} removida` : `${label} alterada`);
    }
    if (!parts.length && bs.acceptance_criteria !== as.acceptance_criteria) parts.push('Critérios de Aceite alterados (texto fora dos itens AC-XX)');
    return parts.length ? parts.join('; ') : 'sem mudança no HASH_SCOPE';
}

module.exports = {
    CONFIG_PATH, loadConfig, parseConfig, currentScope, scopeOf, contractSections, canonicalContract,
    contractHash, fingerprint, diffSummary,
};

if (require.main === module) {
    const args = process.argv.slice(2);
    const flag = name => { const a = args.find(x => x === `--${name}` || x.startsWith(`--${name}=`)); return a === undefined ? undefined : (a.includes('=') ? a.split('=').slice(1).join('=') : true); };
    const [file] = args.filter(a => !a.startsWith('--'));
    if (!file || !fs.existsSync(file)) {
        console.error('Uso: node scripts/lib/spec-hash.js <spec.md> [--scope=<id>] [--canonical] [--fingerprint]');
        process.exit(2);
    }
    const content = fs.readFileSync(file, 'utf8');
    const scope = typeof flag('scope') === 'string' ? flag('scope') : undefined;
    try {
        if (flag('canonical')) process.stdout.write(canonicalContract(content, { scope }));
        else if (flag('fingerprint')) console.log(JSON.stringify(fingerprint(content, { scope }), null, 2));
        else console.log(contractHash(content, { scope }));
    } catch (e) {
        console.error(e.message);
        process.exit(2);
    }
}
