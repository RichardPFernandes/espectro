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

// --- PRI-320: "Arquivo:" inline na prosa do passo ---

test('inline: caminhos até o próximo rótulo, com ponto final da frase aparado (casos reais da PRI-318)', () => {
    assert.deepStrictEqual(declaredPaths('Resolver central. Arquivo: scripts/invalidate.js. Critérios: AC-01, AC-02'), { paths: ['scripts/invalidate.js'], fileLines: 1 });
    assert.deepStrictEqual(
        declaredPaths('Templates chamam `scripts/invalidate.js guard`. Arquivo: .claude/commands/verify.md, .claude/commands/plan.md. Critérios: AC-02'),
        { paths: ['.claude/commands/verify.md', '.claude/commands/plan.md'], fileLines: 1 },
    );
    assert.deepStrictEqual(declaredPaths('Docs. Arquivo: docs/a.md, CLAUDE.md. Critérios: AC-09'), { paths: ['docs/a.md', 'CLAUDE.md'], fileLines: 1 });
    assert.deepStrictEqual(declaredPaths('Testes. Arquivo: scripts/a.test.js. Verificação: passa.'), { paths: ['scripts/a.test.js'], fileLines: 1 });
});

test('inline: sem rótulo depois, vale até o fim da linha; com crases também', () => {
    assert.deepStrictEqual(declaredPaths('Ajustar. Arquivo: `src/A.java`, `src/B.java`'), { paths: ['src/A.java', 'src/B.java'], fileLines: 1 });
    assert.deepStrictEqual(declaredPaths('Ajustar — Arquivo: src/A.java'), { paths: ['src/A.java'], fileLines: 1 });
});

test('inline: abreviação ".../X.java", diretório e placeholder continuam UNKNOWN (nunca inferir diretório)', () => {
    for (const t of ['x. Arquivo: `.../Foo.java`. Critérios: AC-1', 'x. Arquivo: src/main/. Critérios: AC-1', 'x. Arquivo: a definir. Critérios: AC-1']) {
        const r = declaredPaths(t);
        assert.deepStrictEqual([r.paths, r.fileLines], [UNKNOWN, 1], t);
    }
});

test('inline: duas declarações no passo (inline + linha própria, ou duas inline) => UNKNOWN', () => {
    assert.deepStrictEqual(declaredPaths('x. Arquivo: a.js.\n   - Arquivo: b.js'), { paths: UNKNOWN, fileLines: 2 });
    assert.deepStrictEqual(declaredPaths('x. Arquivo: a.js. Depois. Arquivo: b.js.'), { paths: UNKNOWN, fileLines: 2 });
});

test('inline: "arquivo:" em texto corrido (minúsculo, sem fronteira de frase) e passo sem declaração não contam', () => {
    assert.deepStrictEqual(declaredPaths('Abrir o arquivo: x.js e ler'), { paths: UNKNOWN, fileLines: 0 });
    assert.deepStrictEqual(declaredPaths('Mostrar o Arquivo: x.js no cartão'), { paths: UNKNOWN, fileLines: 0 });
    assert.deepStrictEqual(declaredPaths('Passo sem arquivo nenhum. Critérios: AC-1'), { paths: UNKNOWN, fileLines: 0 });
});

// --- PRI-320, achados da revisão independente ---
const { declaredAcIds } = require('./plan-paths');

test('B1: declaredAcIds lê Critérios na linha própria (linha inteira) e inline (até o próximo rótulo); união', () => {
    assert.deepStrictEqual(declaredAcIds('x\n   - Critérios: AC-01, AC-02\n   - Verificação: t'), ['AC-01', 'AC-02']);
    assert.deepStrictEqual(declaredAcIds('Resolver. Arquivo: a.js. Critérios: AC-03, AC-04. Verificação: cobre AC-09'), ['AC-03', 'AC-04']);
    assert.deepStrictEqual(declaredAcIds('Sem critérios aqui'), []);
});

test('M1: menção "arquivo:" não reconhecida junto de declaração válida => UNKNOWN (nunca lista parcial)', () => {
    for (const t of ['Resolver (Arquivo: a.js, b.js)\n   - Arquivo: c.js', 'Resolver, Arquivo: a.js, b.js\n   - Arquivo: c.js', '**Arquivo:** a.js\n   - Arquivo: c.js']) {
        assert.strictEqual(declaredPaths(t).paths, UNKNOWN, t);
    }
});

test('m1: "Testes:" depois da lista não é cortado em silêncio; m3: n/a e elipse viram UNKNOWN', () => {
    assert.strictEqual(declaredPaths('x. Arquivo: src/A.java. Testes: src/ATest.java. Critérios: AC-1').paths, UNKNOWN);
    for (const t of ['x. Arquivo: n/a', 'x. Arquivo: N/A', 'x. Arquivo: a.js, b.js... Critérios: AC', 'x. Arquivo: a.js, b.js…']) {
        assert.strictEqual(declaredPaths(t).paths, UNKNOWN, t);
    }
    assert.deepStrictEqual(declaredPaths('x. Arquivo: a.js, b.js. Critérios: AC').paths, ['a.js', 'b.js']);
});
