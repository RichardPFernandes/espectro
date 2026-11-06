// Cabeçalhos e comentários de spec — funções puras, sem I/O nem dependências.
// Extraídas de spec-validator.js (PRI-266) para que spec-hash.js, a implementação
// única do HASH_SCOPE, não carregue transitivamente spec-template/state-writer/cas.
// spec-validator.js continua reexportando as três; o comportamento não muda.

function normalizeHeading(text) {
    return text
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[*_`]/g, '')
        .trim();
}

// Retorna {level, text} se a linha for cabeçalho Markdown (#..####) ou Textile (h1.-h4.).
function parseHeading(line) {
    const md = /^\s{0,3}(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line);
    if (md) return { level: md[1].length, text: md[2] };
    const textile = /^\s*h([1-4])\.\s+(.+?)\s*$/.exec(line);
    if (textile) return { level: Number(textile[1]), text: textile[2] };
    return null;
}

function stripComments(content) {
    // Instruções inline do template ficam em comentário HTML — não contam como
    // conteúdo (senão um template copiado sem preencher passaria no portão).
    return content.replace(/<!--[\s\S]*?-->/g, '');
}

module.exports = { normalizeHeading, parseHeading, stripComments };
