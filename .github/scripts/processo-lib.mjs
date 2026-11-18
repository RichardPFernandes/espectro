// Regras do processo-check (Acordo de desenvolvimento v2, seção 8).
// Funções puras, sem rede nem dependências: usadas pelo check de CI
// (processo-check.mjs) e pelo hook do Claude Code (.claude/hooks/processo-level.mjs).
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CONFIG_PATH = path.join(HERE, '..', 'processo.json');

export function loadConfig(file = DEFAULT_CONFIG_PATH) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Glob mínimo: `**/` = zero ou mais diretórios, `**` = qualquer coisa,
// `*` = qualquer coisa sem `/`, `?` = um caractere sem `/`.
export function globToRegExp(glob) {
    let re = '';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*') {
            if (glob[i + 1] === '*') {
                if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
            } else {
                re += '[^/]*';
            }
        } else if (c === '?') {
            re += '[^/]';
        } else {
            re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        }
    }
    return new RegExp(`^${re}$`);
}

export function matchesAny(file, globs, { ignoreCase = false } = {}) {
    let p = String(file).replace(/\\/g, '/').replace(/^\.\//, '');
    if (ignoreCase) p = p.toLowerCase();
    return globs.some((g) => globToRegExp(ignoreCase ? g.toLowerCase() : g).test(p));
}

// Conteúdo da seção `## <heading>` (aceita sufixo, como `## Evidência (ACs)`)
// até o próximo `## ` fora de bloco de código (ou fim).
export function extractSection(body, heading) {
    const lines = String(body ?? '').replace(/\r\n?/g, '\n').split('\n');
    const head = new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu');
    const start = lines.findIndex((l) => head.test(l.trim()));
    if (start === -1) return null;
    const out = [];
    let fence = false;
    for (let i = start + 1; i < lines.length; i++) {
        if (/^\s*(```|~~~)/.test(lines[i])) fence = !fence;
        if (!fence && /^##\s/.test(lines[i])) break;
        out.push(lines[i]);
    }
    return out.join('\n');
}

// Linhas que contam como evidência: sem comentários HTML, sem linhas em branco
// e sem as linhas copiadas sem mudança do template de PR (cabeçalho e linha de exemplo).
export function evidenceLines(body, heading, templateBody = '') {
    const section = extractSection(body, heading);
    if (section === null) return null;
    // Comentário sem fechamento vale até o fim da seção.
    const strip = (s) => s.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
    const norm = (l) => l.trim().replace(/\s+/g, ' ');
    const templateSection = extractSection(templateBody, heading) ?? '';
    const tLines = strip(templateSection).split('\n').map(norm).filter(Boolean);
    const placeholders = new Set(tLines);
    // Marcadores `<...>` do template: linha que ainda os contém não foi preenchida.
    const markers = tLines.flatMap((l) => l.match(/<[^<>]+>/g) ?? []);
    const emptyRow = (l) => /^\|[\s|:-]*\|?$/.test(l);
    return strip(section).split('\n').map(norm).filter((l) => l && !placeholders.has(l)
        && !emptyRow(l) && !markers.some((m) => l.includes(m)));
}

// Mapa de capacidades (scripts/capability-map.js, cabeçalhos de docs/capacidades). O aviso é
// só um sinal: se o mapa não carrega (checkout parcial, cabeçalho inválido), o check segue sem ele.
export function loadCapabilityMap({ script = path.join(HERE, '..', '..', 'scripts', 'capability-map.js'), dir = path.join(HERE, '..', '..', 'docs', 'capacidades') } = {}) {
    try {
        const { readCapabilities, ownersOf, isCovered } = createRequire(import.meta.url)(script);
        return { capabilities: readCapabilities(dir), ownersOf, isCovered };
    } catch (e) {
        return { unavailable: String(e.message).split('\n')[0].slice(0, 160) };
    }
}

// IDs de AC da SPEC (`- AC-01: ...`, `AC-2: ...`, `**AC-3**`), sem blocos de código, comentários HTML
// e ACs marcados "(removido". Dado do PR: só regex, nunca interpretado; linha com mais de 500 caracteres é ignorada, o que limita o custo da regex.
// Linhas acima de 500 caracteres são ignoradas. Devolve [{ id, n }], n = número como string sem zeros à esquerda.
export function specAcIds(content) {
    const text = String(content ?? '').replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?(?:-->|$)/g, '');
    const out = new Map();
    let fence = false;
    for (const l of text.split('\n')) {
        if (/^\s*(```|~~~)/.test(l)) { fence = !fence; continue; }
        const m = fence || l.length > 500 ? null : l.match(/^[ \t]*(?:[-*][ \t]+)?(?:\*\*|__)?[ \t]*(AC-(\d+))(?![\p{L}\p{N}])/iu);
        const n = m?.[2].replace(/^0+(?=\d)/, '');
        if (m && !/\(removido/i.test(l) && !out.has(n)) out.set(n, m[1]);
    }
    return [...out].map(([n, id]) => ({ id, n }));
}

const FIX_LEVEL = 'Para reclassificar, troque o rótulo (subir de nível exige o Richard).';

// files: [{ filename, status, additions, deletions, previous_filename? }] (formato da API do GitHub).
export function evaluate({ labels = [], body = '', files = [], templateBody = '', config, capabilityMap, specs = [] }) {
    const errors = [];
    const info = [];
    const warnings = [];
    const levelLabels = Object.keys(config.levels);
    // Rótulos do GitHub não diferenciam maiúsculas.
    const found = [...new Set(labels.map((l) => String(l).toLowerCase()).filter((l) => levelLabels.includes(l)))];

    if (found.length === 0) {
        errors.push(`Sem rótulo de nível. Adicione exatamente um entre ${levelLabels.join(', ')}.`);
    } else if (found.length > 1) {
        errors.push(`Há ${found.length} rótulos de nível (${found.join(', ')}). Deixe só um. ${FIX_LEVEL}`);
    }
    const level = found.length === 1 ? config.levels[found[0]] : null;
    if (level) info.push(`nível: ${level}`);

    const heading = config.evidenceHeading;
    const ev = evidenceLines(body, heading, templateBody);
    if (ev === null) {
        errors.push(`Falta a seção "## ${heading}" no corpo do PR. Use o template (.github/pull_request_template.md) e preencha a Evidência: AC, resultado e prova.`);
    } else if (ev.length === 0) {
        errors.push(`A seção "## ${heading}" está vazia (comentários HTML e linhas do template não contam). Preencha com AC, resultado e prova: saída de teste, print ou link do CI.`);
    }

    if (level === 'leve') {
        const { maxChangedLines, forbiddenNewFiles, renameAllowedPrefixes = [] } = config.leve;
        // Mover SPEC/handoff/evidence de issue fechada para o arquivo morto não cria arquivo novo:
        // só `renamed` cujo destino começa com um prefixo permitido (default: nenhum).
        const movedToArchive = (f) => f.status === 'renamed'
            && renameAllowedPrefixes.some((pre) => String(f.filename).startsWith(pre));
        const added = files.filter((f) => ['added', 'renamed', 'copied'].includes(f.status)
            && !movedToArchive(f)
            && matchesAny(f.filename, forbiddenNewFiles, { ignoreCase: true }));
        if (added.length) {
            errors.push(`Nível leve não admite SPEC, handoff ou evidence separado: ${added.map((f) => f.filename).join(', ')}. Remova o arquivo (a evidência vai na seção "${heading}" do PR). ${FIX_LEVEL}`);
        }
        const counted = files.filter((f) => !matchesAny(f.filename, config.ignoredForLineCount));
        const lines = counted.reduce((n, f) => n + (f.additions || 0) + (f.deletions || 0), 0);
        info.push(`linhas alteradas (sem lockfiles/snapshots/fixtures gerados): ${lines}/${maxChangedLines}`);
        if (lines > maxChangedLines) {
            errors.push(`Nível leve: ${lines} linhas alteradas, acima do limite de ${maxChangedLines} (adições + remoções, sem lockfiles, snapshots e fixtures gerados). Divida o PR. ${FIX_LEVEL}`);
        }
    }
    if (level === 'alto' && config.alto) {
        const { requiredSections = [], specPathPattern } = config.alto;
        for (const s of requiredSections) {
            const lines = evidenceLines(body, s, templateBody);
            if (!lines?.length) errors.push(`Nível alto: falta a seção "## ${s}" preenchida no corpo do PR. O /pri-autorizo monta Rollback e Readback.`);
        }
        if (specPathPattern && !new RegExp(specPathPattern).test(String(body ?? ''))) {
            errors.push('Nível alto: o corpo do PR precisa citar a SPEC da issue (tasks/<pasta>/SPEC.md).');
        }
    }
    if (capabilityMap?.unavailable) {
        info.push(`aviso de capacidade indisponível: ${capabilityMap.unavailable}`);
    } else if (capabilityMap) {
        // Renomear ou remover também é mudar o código (ou a spec): vale o nome antigo e o novo.
        const names = files.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean));
        const code = new Map();
        for (const name of names.filter(capabilityMap.isCovered)) {
            for (const id of capabilityMap.ownersOf(capabilityMap.capabilities, name)) code.set(id, [...(code.get(id) ?? []), name]);
        }
        const states = capabilityMap.capabilities.filter((c) => code.has(c.id));
        if (states.length) info.push(`capacidades com código alterado: ${states.map((c) => `${c.id} (${c.spec})`).join(', ')}`);
        for (const c of states) {
            const spec = `docs/capacidades/${c.id}.md`;
            if (names.includes(spec)) continue;
            const changed = [...new Set(code.get(c.id))];
            const shown = changed.slice(0, 3).join(', ') + (changed.length > 3 ? ` +${changed.length - 3}` : '');
            warnings.push(c.spec === 'sem-spec'
                ? `Capacidade "${c.id}": ainda sem spec viva e o PR muda código dela (${shown}). Se o comportamento mudou, a spec viva dela (uma página, no molde de docs/capacidades/estado.md) nasce neste PR em ${spec}; se não mudou, diga isso na Evidência. Aviso, não reprova.`
                : `Capacidade "${c.id}": o PR muda código dela (${shown}) e não toca a spec viva (${spec}). Se o comportamento mudou, atualize a spec no mesmo PR; se não mudou, diga isso na Evidência. Aviso, não reprova.`);
        }
    }
    // SPEC alterada: cada AC aparece na Evidência? Aviso só com a seção preenchida (senão o erro acima já cobre).
    for (const { filename, content } of specs) {
        const acs = specAcIds(content);
        const evText = ev?.length ? ev.join('\n') : '';
        const missing = acs.filter((a) => !new RegExp(`\\bAC-0*${a.n}\\b`, 'i').test(evText));
        info.push(`SPEC alterada: ${filename} (${acs.length} ACs, ${acs.length - missing.length} na Evidência)`);
        if (missing.length && evText) {
            const ids = missing.slice(0, 5).map((a) => a.id).join(', ') + (missing.length > 5 ? ` +${missing.length - 5}` : '');
            warnings.push(`SPEC "${filename}": o AC ${ids} não aparece na Evidência. Cada AC da SPEC alterada entra na Evidência com resultado e prova (ou é removido da SPEC com "(removido em AAAA-MM-DD: motivo)"). Aviso, não reprova.`);
        }
    }
    return { ok: errors.length === 0, level, errors, warnings, info };
}
