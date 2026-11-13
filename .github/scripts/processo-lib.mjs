// Regras do processo-check (Acordo de desenvolvimento v2, seção 8).
// Funções puras, sem rede nem dependências: usadas pelo check de CI
// (processo-check.mjs) e pelo hook do Claude Code (.claude/hooks/processo-level.mjs).
import fs from 'node:fs';
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

const FIX_LEVEL = 'Para reclassificar, troque o rótulo (subir de nível exige o Richard).';

// files: [{ filename, status, additions, deletions, previous_filename? }] (formato da API do GitHub).
export function evaluate({ labels = [], body = '', files = [], templateBody = '', config }) {
    const errors = [];
    const info = [];
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
        const { maxChangedLines, forbiddenNewFiles } = config.leve;
        const added = files.filter((f) => ['added', 'renamed', 'copied'].includes(f.status)
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
    return { ok: errors.length === 0, level, errors, info };
}
