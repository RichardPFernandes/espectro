# PRI-60 — versão candidata

> Captura histórica da entrega indicada neste documento. Para o consumo entregue
> na PRI-63 (a50ff9f), o entrypoint de 08/10 e o retorno, consulte
> [consumer-operations.md](consumer-operations.md) e
> [extraction-handoff.md](extraction-handoff.md). As provas abaixo permanecem
> atribuídas à sua revisão original; não são instruções atuais de troca.

A plataforma candidata está neste repositório. O app-back continua a execução
ativa: os scripts de lá não foram substituídos e nenhum watcher novo foi iniciado.

## O que mudou de caminho

| Antes | Candidata |
| -- | -- |
| Código da plataforma dentro de `app-back` | Mesmos caminhos relativos (`scripts/`, `dashboard/`, `.graph/`, `templates/`, `docs/`) neste repo |
| Raiz do código = raiz do projeto | `PRISMA_ROOT` é o diretório deste checkout; `REPO_PATH` ou o cwd é a raiz do consumidor |
| Irmãos fixos `app-front`, `app-core`, `mo-entity` | `WATCHER_SIBLING_REPOS` |
| `mvn compile` / `mvn test` embutidos | `PRE_BUILD_COMMAND`, `TEST_COMMAND`, `TEST_SCOPED_COMMAND` |
| Preview Maven/Quarkus/Grunt sempre ligado | `PREVIEW_ADAPTER=maven-quarkus-grunt` |
| Palavras de módulo TMS no consolidator | `CONSOLIDATOR_MODULE_KEYWORDS_FILE` no consumidor |

Estado, `memory/`, bindings e o `.env` com segredos ficam no app-back. Esta
candidata não copia esses registros e não grava neles por conta própria.

## Como o app-back consome

O consumo final está em [consumption.md](consumption.md) e no exemplo INATIVO
`app-back/scripts/prisma-consumer.env.example`. O checkout de código é a revisão
fixada desta branch; estado/configuração/.env/refs continuam no consumidor.

A captura anterior descrevia `prisma-consumer.env`/config da primeira candidata;
a configuração completa mantém também o package-prefix e o mapa ResponseFactory
do app-back. Não carregar ou substituir .env automaticamente. Não iniciar
watcher da candidata no subject do watcher da origem: PRI-61 verifica integração,
PRI-62 demonstra retorno da mesma revisão e PRI-63 admite cutover.

## Como voltar

Manter os comandos da candidata inativos até os gates de integração/retorno/cutover. A execução anterior permanece nos scripts deste
período que ainda estão no app-back. Nada nesta candidata apaga essa origem,
regrava `state.json` histórico nem troca o watcher que já estava no ar.

## Limites

A lista aceita na PRI-58 tem 230 arquivos (11 extrair, 219 adaptar). Arquivos
`manter` e `adiar` não entraram. `node_modules` não faz parte da candidata.
Direitos BND001, snapshot físico da origem e recuperação byte a byte continuam
não demonstrados. RRC-F31-001/002 não foram aplicados. Cutover é a PRI-63, depois
da validação PRI-61 e da prova de retorno PRI-62.

## Atualização da evidência PRI-60

Richard confirmou os direitos dos230selecionados neste repo privado; o snapshot
dos230arquivos foi recuperado isoladamente com hashes/tamanhos/modos idênticos.
As frases anteriores sobre direitos/snapshot não demonstrados registram a captura
original, superada apenas nesse escopo. Não fecha BND001 global ou recovery de
estado/checkout inteiro. Detalhes atuais em provenance/extraction-manifest.json.
