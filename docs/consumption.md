# Consumo da candidata PRI-60

> Captura histórica da entrega indicada neste documento. Para o consumo entregue
> na PRI-63 (a50ff9f), o entrypoint de 08/10 e o retorno, consulte
> [consumer-operations.md](consumer-operations.md) e
> [extraction-handoff.md](extraction-handoff.md). As provas abaixo permanecem
> atribuídas à sua revisão original; não são instruções atuais de troca.

Código/assets da lista aceita PRI-58 foram extraídos em branch
`feat/pri-60-platform-extraction`. Esta entrega prepara versão fixável para PRI-61
e PRI-62; a execução ativa do app-back foi preservada. Confira o commit/tree no
handoff FINAL e manifesto; não resolver latest nem reatar uma Run existente.

## Requisitos do recorte

Dois pacotes Node existentes e seus locks separados: scripts/ e dashboard/.
Instalação verificada nesta máquina com Node20.20.2/npm10.8.2 usando `npm ci
--ignore-scripts --no-audit --no-fund` em cada pacote. Isso identifica ambiente
executado, sem alegar matriz suportada ou CI. Não há novo package/runner de raiz.

## Roots e configuração

`PRISMA_ROOT` identifica o checkout de código/assets candidato fixado; `REPO_PATH`
identifica o consumidor principal. Cwd do agente é o worktree admitido. Factories
preservam opções de injeção existentes; REPO_PATH/cwd é fallback de contexto de
projeto, nunca __dirname da plataforma. Execute de dentro do consumidor ou forneça
root explicitamente. Paths de código/assets são relativos ao pacote Prisma;
paths de estado/config/.env/prefs/pid/history pertencem ao consumidor.

A .env.example deste repo é documentação neutra. O .env real fica no consumidor;
nunca criar cópia no Prisma. Config HASH_SCOPE e contracts do consumidor são
referências existentes e conservam versões/IDs históricos. Templates/esquemas
distribuídos não substituem automaticamente configuração/bindings. Não copiar
runs/specs/knowledge/dados para permitir execução em outro diretório.

## Adapters específicos

WATCHER_SIBLING_REPOS e WATCHER_MAIN_REPO_NAME preservam slugs/keys explícitos.
PRE_BUILD_COMMAND, TEST_COMMAND/TEST_SCOPED_COMMAND declaram toolchain; ausência
não escolhe Maven ou toolchain alternativa. CONSOLIDATOR_MODULE_KEYWORDS_FILE,
SPEC_RULE_PACKAGE_PREFIX e OPENAPI_RESPONSE_FACTORY_FILE mantêm taxonomia e
heurísticas específicas no consumidor. PREVIEW_ADAPTER=maven-quarkus-grunt
seleciona somente o adapter existente com seus paths/profiles/refs explícitos;
sem ativação/configuração não resolver banco, Maven, JDK ou sibling de app-back.
Esses seams não são novo Configuration Service, engine, registry ou store.

O app-back conserva a configuração candidata INATIVA em
scripts/prisma-consumer.env.example e docs/prisma-candidate.md na origem; nenhuma
credencial, instrução local ou dado TMS veio para este repo. Exemplos sintéticos e
notas históricas dos assets selecionados identificam a fonte e não são defaults.

## Uso após admissão

Esta entrega não autoriza iniciar watcher/preview/agente com estado vivo. Na
integração admitida, o executável é `$PRISMA_ROOT/scripts/readmine-watcher.js` ou
`$PRISMA_ROOT/dashboard/server.js`, com cwd/REPO_PATH do consumidor e configuração
explícita. Templates de nó devem ser os assets da revisão fixada, e seus scripts
usam PRISMA_ROOT. Não executar os caminhos antigos e novos no mesmo subject.
PRI-61 testa integração nesta revisão; PRI-62 demonstra retorno na mesma revisão;
PRI-63 decide cutover. Fixtures de testes são sintéticas e temporárias. A fixture
original scripts/fixtures/ticket-example.json foi excluída da lista; dry-run
exige fixture sintética explicitamente admitida, sem copiar dados do consumidor.

## Retorno e limites

Ponto anterior do destino:4e413c43d23040739701d8ca778290df93b135ca (bootstrap).
Fonte preservada em app-back, HEAD a1ac43307cc5f275caf5a70ad3068c9af099b127 mais
bytes locais selecionados: HEAD sozinho não recupera ignored/untracked/dirty.
Snapshot local dos230bytes selecionados e restore isolado hash/mode-a-hash/mode
foram registrados no run PRI-60 na origem; não estão no Git Prisma, não abrangem
registros, .env ou checkout inteiro. Trocar revisão de código não autoriza
restaurar/migrar estado/Record, fazer backfill/rebind ou repetir efeito incerto.
UNKNOWNs residuais/RRC-F31-001/002 mantidos; nenhuma alegação runtime/CI/cutover
além do recorte de testes/evidências efetivamente registrado.
