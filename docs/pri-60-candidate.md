# PRI-60 — versão candidata

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

A partir da raiz do app-back, sem alterar o processo que já está rodando:

```bash
set -a
source ./prisma-consumer.env
set +a
node ../prisma/scripts/readmine-watcher.js
```

O dashboard da candidata usa a mesma regra: `REPO_PATH` (ou o diretório de
trabalho) é o consumidor; o código vem deste checkout. `prisma-consumer.env` no
app-back reúne só a config dogfood, sem segredos. O `.env` atual do app-back
continua sendo a fonte das credenciais quando o processo da candidata parte
daquela raiz.

## Como voltar

Não usar o comando acima. A execução anterior permanece nos scripts deste
período que ainda estão no app-back. Nada nesta candidata apaga essa origem,
regrava `state.json` histórico nem troca o watcher que já estava no ar.

## Limites

A lista aceita na PRI-58 tem 230 arquivos (11 extrair, 219 adaptar). Arquivos
`manter` e `adiar` não entraram. `node_modules` não faz parte da candidata.
Direitos BND001, snapshot físico da origem e recuperação byte a byte continuam
não demonstrados. RRC-F31-001/002 não foram aplicados. Cutover é a PRI-63, depois
da validação PRI-61 e da prova de retorno PRI-62.
