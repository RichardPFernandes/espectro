// Template canônico de spec (templates/spec.md.template) — ponto de partida obrigatório
// de toda spec nova. Este módulo:
//   - renderiza o template trocando só os campos que vêm do Redmine (número, título,
//     descrição → ## Contexto). Critérios de Aceite nunca são preenchidos aqui;
//   - lê `spec_template_version` do frontmatter de uma spec (null = spec legada,
//     anterior ao template — o validador só avisa, não reprova);
//   - grava essa versão no state.json do run (rastreabilidade de qual template a spec
//     seguiu);
//   - expõe os comentários HTML do template, que o spec-validator usa para saber se a
//     instrução ao autor ainda está lá (seção copiada e não preenchida).
// Sem dependência de spec-validator (que importa este módulo).
//
// Uso como CLI:
//   node scripts/lib/spec-template.js init <ticket> --title "<assunto>" [--out <arquivo>] < descricao.txt
//     Grava a spec renderizada em --out (padrão memory/spec/<ticket>-spec.md, relativo
//     ao cwd). Nunca sobrescreve: arquivo existente → exit 1 sem mexer.
//   node scripts/lib/spec-template.js record-version <spec.md> <state.json>
//     Grava state.spec_template_version a partir do frontmatter da spec (legada: nada).
//   exit 0 = ok, 1 = destino já existe / state ilegível, 2 = uso incorreto.

const fs = require('fs');
const path = require('path');
const stateWriter = require('../state-writer');
const { SKIP } = require('../cas');

const TEMPLATE_PATH = path.join(__dirname, '..', '..', 'templates', 'spec.md.template');
const SPEC_TEMPLATE_VERSION = 1;
const SUPPORTED_VERSIONS = [1];

let cachedTemplate = null;
function readTemplate(file = TEMPLATE_PATH) {
    if (file !== TEMPLATE_PATH) return fs.readFileSync(file, 'utf8');
    if (cachedTemplate == null) cachedTemplate = fs.readFileSync(TEMPLATE_PATH, 'utf8');
    return cachedTemplate;
}

const normalizeComment = c => String(c).replace(/\s+/g, ' ').trim();

// Comentários HTML do template, normalizados (espaços colapsados) — comparados assim
// para que reindentar ou reformatar o comentário não o faça passar por conteúdo do autor.
function templateComments(template = readTemplate()) {
    return new Set((String(template).match(/<!--[\s\S]*?-->/g) || []).map(normalizeComment));
}

// Frontmatter YAML simples (chave: valor escalar) do bloco inicial entre "---".
function parseFrontmatter(content) {
    const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(String(content || ''));
    if (!m) return null;
    const data = {};
    for (const line of m[1].split(/\r?\n/)) {
        const kv = /^([A-Za-z_][\w-]*):\s*(.*?)\s*$/.exec(line);
        if (kv) data[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
    }
    return data;
}

/**
 * Versão do template declarada no frontmatter: inteiro, `null` se a spec não declara
 * (legada) ou NaN se declara algo que não é inteiro positivo.
 */
function templateVersionOf(content) {
    const raw = parseFrontmatter(content)?.spec_template_version;
    if (raw == null || raw === '') return null;
    return /^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : NaN;
}

// Descrição do Redmine dentro de ## Contexto: cabeçalho de nível 1-2 (Markdown ou
// Textile) viraria uma seção nova da spec e cortaria o Contexto — desce para nível 3.
function demoteHeadings(text) {
    return text.split('\n').map(line => line
        .replace(/^(\s{0,3})#{1,2}(\s+)/, '$1###$2')
        .replace(/^(\s*)h[12]\.(\s+)/, '$1h3.$2')).join('\n');
}

/**
 * Spec nova a partir do template. Só número, título e descrição vêm do Redmine; o
 * resto (Objetivo, Escopo, Critérios de Aceite...) fica com o comentário de instrução
 * para o autor preencher e remover.
 * @param {{ticketId: number|string, title?: string, description?: string}} fields
 * @param {{template?: string}} [opts]
 */
function renderSpecFromTemplate({ ticketId, title, description }, { template } = {}) {
    if (ticketId == null || !String(ticketId).trim()) throw new TypeError('renderSpecFromTemplate: ticketId obrigatório');
    const tpl = template ?? readTemplate();
    const desc = demoteHeadings(String(description || '').replace(/\r\n?/g, '\n').trim());
    const values = {
        TICKET_ID: String(ticketId).trim(),
        TITULO: String(title || '').trim() || '(sem título)',
        DESCRICAO: desc,
    };
    // Função como replacement: "$&"/"$1" dentro da descrição não são interpretados.
    return tpl.replace(/\{\{([A-Z_]+)\}\}/g, (all, key) => (key in values ? values[key] : all));
}

/**
 * Grava spec_template_version no state.json (só se mudou). Spec legada (sem versão)
 * não grava nada. Devolve a versão gravada, ou null se nada mudou.
 */
function recordTemplateVersion(statePath, version) {
    if (!Number.isInteger(version)) return null;
    JSON.parse(fs.readFileSync(statePath, 'utf8')); // ilegível continua lançando, como antes
    const written = stateWriter.update(statePath, state => {
        if (state.spec_template_version === version) return SKIP;
        state.spec_template_version = version;
    }, { operation: 'spec_template_version', actor: 'agent' });
    return written ? version : null;
}

module.exports = {
    TEMPLATE_PATH, SPEC_TEMPLATE_VERSION, SUPPORTED_VERSIONS,
    readTemplate, templateComments, normalizeComment, parseFrontmatter, templateVersionOf,
    renderSpecFromTemplate, recordTemplateVersion, demoteHeadings,
};

function flag(args, name) {
    const i = args.indexOf(name);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
}

if (require.main === module) {
    const [cmd, ...args] = process.argv.slice(2);
    if (cmd === 'init' && args[0] && !args[0].startsWith('--')) {
        const ticketId = args[0];
        const out = flag(args, '--out') || path.join('memory', 'spec', `${ticketId}-spec.md`);
        if (fs.existsSync(out)) {
            console.error(`${out} já existe — não sobrescrevo (spec de ciclo anterior ou gerada pelo watcher).`);
            process.exit(1);
        }
        const description = process.stdin.isTTY ? '' : fs.readFileSync(0, 'utf8');
        const content = renderSpecFromTemplate({ ticketId, title: flag(args, '--title'), description });
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, content, { flag: 'wx' });
        console.log(`Spec criada a partir do template v${SPEC_TEMPLATE_VERSION}: ${out}`);
        process.exit(0);
    }
    if (cmd === 'record-version' && args.length >= 2) {
        const [specFile, stateFile] = args;
        if (!fs.existsSync(specFile) || !fs.existsSync(stateFile)) {
            console.error('Arquivo inexistente.');
            process.exit(2);
        }
        const version = templateVersionOf(fs.readFileSync(specFile, 'utf8'));
        try {
            recordTemplateVersion(stateFile, version);
        } catch (e) {
            console.error(`state.json ilegível: ${e.message}`);
            process.exit(1);
        }
        console.log(Number.isInteger(version)
            ? `spec_template_version=${version} em ${stateFile}`
            : 'Spec sem spec_template_version (legada) — state.json não alterado.');
        process.exit(0);
    }
    console.error('Uso: node scripts/lib/spec-template.js init <ticket> --title "<assunto>" [--out <arquivo>] < descricao\n' +
        '     node scripts/lib/spec-template.js record-version <spec.md> <state.json>');
    process.exit(2);
}
