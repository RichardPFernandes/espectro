// node --test scripts/lib/plan-paths.test.js
const test = require('node:test');
const assert = require('node:assert');
const { parsePathsLine, declaredPaths, isAnnotation, UNKNOWN } = require('./plan-paths');

test('isAnnotation: só o que é claramente anotação sai; qualquer item com "." ou "/" continua candidato', () => {
    const ann = x => isAnnotation(x, x);
    for (const x of ['@Path', '44042', 'exportar-dados', 'InsightsIAService', 'extends Foo', 'GET status', 'GET /api/x', '#btn']) assert.ok(ann(x), x);
    for (const x of ['a/b', 'Foo.java', '.env', '.env.local', 'Dockerfile.prod', '.gitignore', 'build.gradle.kts', 'schema.prisma', 'Dockerfile', 'gradlew', 'a.js, b.js']) assert.ok(!ann(x), x);
});

test('parsePathsLine: caso real do plano 44042 (passo 1 e 5)', () => {
    assert.deepStrictEqual(
        parsePathsLine('   - Arquivo: `src/main/java/br/InsightsIAService.java` (novo, `@ApplicationScoped`) e `src/main/java/br/Res.java` (passa a delegar).'),
        ['src/main/java/br/InsightsIAService.java', 'src/main/java/br/Res.java'],
    );
    assert.deepStrictEqual(
        parsePathsLine('   - Arquivo: `app-front/app/x/insights-ia.component.js`, `insights-ia.html` (novos, no worktree `/Users/r/app-front/.claude/worktrees/44042`, branch `44042`); registro em `app/index.html`'),
        ['app-front/app/x/insights-ia.component.js', 'insights-ia.html', 'app/index.html'],
    );
});

test('parsePathsLine: sem backticks segue o critério antigo', () => {
    assert.deepStrictEqual(parsePathsLine('Arquivo: src/a.js, src/b.js'), ['src/a.js', 'src/b.js']);
    assert.strictEqual(parsePathsLine('Arquivo: a definir'), null);
});

test('declaredPaths: duas linhas "Arquivo:" => UNKNOWN; nenhuma => UNKNOWN com fileLines 0', () => {
    assert.deepStrictEqual(declaredPaths('1. x\n   - Arquivo: `a.js`\n   - Arquivo: `b.js`'), { paths: UNKNOWN, fileLines: 2 });
    assert.deepStrictEqual(declaredPaths('1. x\n   - Verificação: t'), { paths: UNKNOWN, fileLines: 0 });
    assert.deepStrictEqual(declaredPaths('1. x\n   - Arquivo: `a.js`'), { paths: ['a.js'], fileLines: 1 });
});

test('irmão forte + item real fora da lista de extensões não é descartado (MAJOR-1 da revisão)', () => {
    for (const x of ['.env.local', '.env.production', 'build.gradle.kts', 'schema.prisma', 'page.jsp', 'id_rsa.pem', 'Dockerfile.prod', '.gitignore', 'gradlew', 'README', 'Foo.java#bar']) {
        const r = parsePathsLine('Arquivo: `src/Foo.java`, `' + x + '`');
        assert.ok(r && r.length === 2, `${x} => ${JSON.stringify(r)}`);
    }
});

test('anotação ao lado de lista numa crase só continua UNKNOWN; caminho absoluto e verbo+rota saem', () => {
    assert.strictEqual(parsePathsLine('Arquivo: `@Path`, `a.js, b.js`'), null);
    assert.deepStrictEqual(parsePathsLine('Arquivo: `GET /api/x`, `/Users/r/wt/44042`, `src/A.java`'), ['src/A.java']);
});
