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
//     trocar o export em cache pelo wrapper antes do primeiro request.
const path = require('path');
const { createRequire } = require('module');

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
