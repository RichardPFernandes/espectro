// Gruntfile usado SÓ pelo preview do dashboard (scripts/preview-manager.js), que roda
// `node preview-gruntfile.js serve` com PREVIEW_FRONT_DIR=<worktree do app-front>.
//
// Por que não `npm start` (= `grunt serve`): o app-front usa grunt 0.4.5, que exige
// grunt-cli global (nem sempre instalado); e grunt-cli novo (liftoff) procura o grunt
// a partir do diretório do --gruntfile externo — aqui, scripts/ — e falha com "Unable
// to find local grunt". Executado direto, este arquivo chama grunt.tasks() do grunt do
// próprio worktree, com gruntfile=este arquivo e base=worktree (o grunt faz chdir pra lá
// antes de carregar, então load-grunt-tasks & cia resolvem no front).
//
// O Gruntfile do app-front fixa connect.options.port=9000 e manda /api e /portal/api
// pra localhost:8080 — o app-back do checkout principal. Aqui ele é carregado como
// está e só duas coisas mudam, sem tocar no repo do front:
//   - porta do connect → PREVIEW_FRONT_PORT (e sem abrir browser sozinho);
//   - regras do connect-modrewrite: localhost:8080 → localhost:PREVIEW_BACK_PORT. O
//     Gruntfile chama require('connect-modrewrite') dentro do middleware, então basta
//     trocar o export em cache pelo wrapper antes do primeiro request;
//   - o app decide "dev" por `location.port === '9000'` (app.js: 401 vai pra /#/login; em
//     "produção" recarrega "/", que no preview é o próprio app → loop de reload). Um
//     middleware na frente serve esses .js com a porta do preview no lugar do 9000 —
//     só a resposta HTTP muda, o arquivo do front fica como está.
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

// `location.port === '9000'` / `== "9000"`: a checagem de "ambiente dev" do app-front.
const DEV_PORT_RE = /(location\.port\s*={2,3}\s*)(['"])9000\2/g;

// Middleware connect: .js do front (app/, .tmp/ ou a raiz, como os serveStatic do
// Gruntfile) que tenha a checagem de porta vai com a porta do preview; o resto segue.
function devPortPatch(frontDir, frontPort) {
    const root = path.resolve(frontDir);
    return (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        let url;
        try { url = decodeURIComponent(String(req.url || '').split('?')[0]); } catch { return next(); }
        if (!url.endsWith('.js')) return next();
        for (const base of [path.join(root, '.tmp'), path.join(root, 'app'), root]) {
            const file = path.resolve(base, `.${path.sep}${url}`);
            if (!file.startsWith(root + path.sep)) return next();
            let text;
            try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
            if (!DEV_PORT_RE.test(text)) return next();
            DEV_PORT_RE.lastIndex = 0;
            res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache');
            return res.end(text.replace(DEV_PORT_RE, `$1$2${frontPort}$2`));
        }
        return next();
    };
}

module.exports = function (grunt) {
    const frontDir = process.env.PREVIEW_FRONT_DIR || process.cwd();
    const backPort = process.env.PREVIEW_BACK_PORT || '8081';
    const frontPort = Number(process.env.PREVIEW_FRONT_PORT) || 9000;
    const original = path.join(frontDir, 'Gruntfile.js');
    const frontRequire = createRequire(original);

    try {
        const id = frontRequire.resolve('connect-modrewrite');
        const real = frontRequire(id);
        const retarget = rule => typeof rule === 'string' ? rule.replace(/\blocalhost:8080\b/g, `localhost:${backPort}`) : rule;
        require.cache[id].exports = (rules, ...rest) => real((rules || []).map(retarget), ...rest);
        grunt.log.writeln(`[preview] proxy localhost:8080 → localhost:${backPort}`);
    } catch (e) {
        grunt.log.error(`[preview] connect-modrewrite não encontrado em ${frontDir} (${e.message}) — rode npm install no worktree do front; o proxy seguiria pro :8080`);
        throw e;
    }

    frontRequire(original)(grunt);
    grunt.config.set('connect.options.port', frontPort);
    const middleware = grunt.config.get('connect.livereload.options.middleware');
    if (typeof middleware === 'function' && frontPort !== 9000) {
        const patch = devPortPatch(frontDir, frontPort);
        grunt.config.set('connect.livereload.options.middleware', (...args) => [patch, ...middleware(...args)]);
        grunt.log.writeln(`[preview] location.port === '9000' (modo dev do app) servido como '${frontPort}'`);
    }
    if (grunt.config.get('connect.livereload.options')) {
        grunt.config.set('connect.livereload.options.open', false);
        // O `watch` (grunt-contrib-watch/gaze antigos) estoura "Maximum call stack size
        // exceeded" no Node 20 e o grunt encerra junto com o connect (#43646). Com
        // keepalive o connect segura o processo e o watch nunca roda — igual ao
        // `connect:livereload:keepalive` local do checkout principal. Sem live reload.
        // PREVIEW_GRUNT_WATCH=true mantém o watch.
        if (!/^(1|true|sim|yes)$/i.test(process.env.PREVIEW_GRUNT_WATCH || '')) {
            grunt.config.set('connect.livereload.options.keepalive', true);
            grunt.log.writeln('[preview] connect com keepalive (sem watch/live reload)');
        }
    }
    grunt.log.writeln(`[preview] connect na porta ${frontPort}`);
};

if (require.main === module) {
    const frontDir = process.env.PREVIEW_FRONT_DIR;
    if (!frontDir) { console.error('[preview] PREVIEW_FRONT_DIR não definido'); process.exit(2); }
    let grunt;
    try { grunt = createRequire(path.join(frontDir, 'Gruntfile.js'))('grunt'); } catch (e) {
        console.error(`[preview] grunt não encontrado em ${frontDir}/node_modules — rode npm install no worktree do front (${e.message})`);
        process.exit(2);
    }
    const tasks = process.argv.slice(2).filter(a => !a.startsWith('-'));
    // Sem cor: a saída vai pro log do painel, não pra um terminal. force: o serve roda
    // htmlhint antes de subir e aborta no primeiro warning — lint que já está no master
    // (#43646: <br> sem fechar) derrubava o preview. O warning segue no log.
    // PREVIEW_GRUNT_FORCE=false volta ao comportamento do grunt serve do repo.
    const force = !/^(0|false|nao|não|no)$/i.test(process.env.PREVIEW_GRUNT_FORCE || '');
    grunt.tasks(tasks.length ? tasks : ['serve'], { gruntfile: __filename, base: frontDir, color: false, force });
}
