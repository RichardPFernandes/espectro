// Detecta quais microsserviços (módulos Maven sob backend/<svc>/) foram tocados por um
// diff, pro nó `test` rodar só `mvn test -pl <módulos>` em vez da suíte inteira.
//
// Regra conservadora: na dúvida, suíte completa. Qualquer arquivo que possa afetar o
// build (pom raiz, backend/pom.xml, .mvn/, src/ de um projeto single-module, config na
// raiz…) derruba o escopo pra [] = suíte completa. Só arquivos de orquestração/docs
// que nunca entram no build Maven (IGNORED_PREFIXES, *.md) são desconsiderados.
//
// Retorno: caminhos de módulo relativos à raiz do repo (ex: "backend/ms-pedidos"),
// que é exatamente o formato que `mvn -pl` aceita. [] = rodar a suíte completa.

const SERVICE_ROOT = 'backend';

const IGNORED_PREFIXES = [
    'memory/', 'docs/', '.graph/', '.claude/', '.agents/', '.codex/', '.cursor/',
    'dashboard/', 'scripts/',
];
const IGNORED_BASENAMES = new Set(['.DS_Store']);

function normalize(file) {
    return String(file || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

function isIgnored(file) {
    const base = file.split('/').pop();
    if (IGNORED_BASENAMES.has(base)) return true;
    if (/\.md$/i.test(file)) return true;
    return IGNORED_PREFIXES.some(p => file.startsWith(p));
}

// "backend/ms-pedidos/src/test/java/X.java" -> "backend/ms-pedidos"; null se o arquivo
// não está dentro de um módulo de serviço (ex: "backend/pom.xml", "pom.xml").
function serviceOf(file, root = SERVICE_ROOT) {
    const parts = file.split('/');
    if (parts.length < 3 || parts[0] !== root || !parts[1] || !parts[2]) return null;
    return `${root}/${parts[1]}`;
}

function analyzeChangedFiles(changedFiles, { root = SERVICE_ROOT } = {}) {
    const files = (changedFiles || []).map(normalize).filter(Boolean);
    const services = new Set();
    const fullSuiteTriggers = [];
    for (const f of files) {
        if (isIgnored(f)) continue;
        const svc = serviceOf(f, root);
        if (svc) services.add(svc);
        else fullSuiteTriggers.push(f);
    }
    const scoped = files.length > 0 && fullSuiteTriggers.length === 0 && services.size > 0;
    return {
        services: scoped ? [...services].sort() : [],
        fullSuite: !scoped,
        reason: files.length === 0 ? 'sem_arquivos_alterados'
            : fullSuiteTriggers.length ? 'arquivo_fora_de_servico'
            : services.size === 0 ? 'nenhum_servico_tocado'
            : 'escopo_reduzido',
        fullSuiteTriggers,
    };
}

function detectAffectedServices(changedFiles, options) {
    return analyzeChangedFiles(changedFiles, options).services;
}

function testCommandFor(services, env = process.env) {
    const scoped = env.TEST_SCOPED_COMMAND;
    if (services && services.length && scoped) return scoped.replaceAll('{services}', services.join(','));
    return env.TEST_COMMAND || null;
}

module.exports = { detectAffectedServices, analyzeChangedFiles, testCommandFor, SERVICE_ROOT };
