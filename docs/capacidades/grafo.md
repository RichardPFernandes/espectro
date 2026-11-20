---
id: grafo
tipo: base
resumo: Define o ciclo da Run como grafo de nós, com o comando de cada nó e o limite de retry.
situacao: ligada
spec: viva
flags: []
modulos:
  - .graph/graph.yaml
  - .graph/README.md
  - .graph/schemas/acceptance-evidence.schema.json
  - .graph/schemas/memory-index.schema.json
  - .graph/schemas/spec-changelog.schema.json
  - .claude/commands/*
---

# Grafo

O ciclo de uma Run é o grafo de `.graph/graph.yaml`: `plan`, `implement`, `review`, `test`,
`verify` e `commit`, mais `fetch_ticket` como entrada alternativa para ticket do Redmine. Cada
nó tem um comando em `.claude/commands/`, que é o prompt do agente daquele nó. As arestas de
falha (`on_fail`) voltam para `implement` ou `test` e têm `max_retries`, e, passado o limite, a
Run escala para o humano. O watcher também despacha `implement-step` e `implement-integrate`
(subtarefas do `implement`), e o `verify` chama o `verify-ui`; nenhum dos três é nó do arquivo
do grafo, e o `init-project` roda uma vez por projeto, fora do ciclo.

Os schemas de artefato (`acceptance-evidence`, `memory-index`, `spec-changelog`) moram em
`.graph/` e têm esta capacidade como dona. Quem os lê está em outras capacidades; o
`memory-index` não tem leitor neste repo, é do consumidor.

## Propósito

O ciclo é um arquivo, e não código espalhado, para que a ordem dos nós, as voltas e o limite de
cada volta estejam escritos num lugar só e possam ser conferidos. O limite existe porque revisão
que reprova três vezes seguidas costuma ser escopo errado no plano, não defeito pequeno: insistir
custa mais que parar e chamar o humano.

## Requisitos

| ID | Comportamento | Porquê |
| -- | -- | -- |
| GRAFO-R01 | A Run avança por `plan` → `implement` → `review` → `test` → `verify` → `commit`; `commit` é o único nó terminal. | Uma ordem fixa permite retomar a Run de onde parou. |
| GRAFO-R02 | `fetch_ticket` é entrada alternativa, só para ticket do Redmine: cria a Run e a spec inicial e passa a `plan`, sem diagnosticar. Tarefa avulsa entra direto em `plan`. | Buscar o ticket e decidir o escopo são papéis separados. |
| GRAFO-R03 | Voltas declaradas: `review` → `implement` (até 3), `test` → `implement` (até 3), `verify` → `test` (até 2). `plan` e `implement` não têm volta declarada. | Toda volta tem limite escrito. |
| GRAFO-R04 | O comando do `verify` também devolve a `implement` (escopo ou comportamento divergente da spec), contando no mesmo limite do `verify`. Essa volta não está no `graph.yaml`. | Divergência entre arquivo e comando, registrada aqui até a F2.7 resolver. |
| GRAFO-R05 | Quem conta a volta e para no limite é o agente do nó, seguindo o comando; ao parar, escala para o humano. O watcher só registra a escalada e zera o contador quando o humano manda retomar. A chave `on_max_retries_exceeded` não é lida por código. | O limite está repetido no comando de `test` e de `verify`: mudar o arquivo sem mudar o comando deixa dois limites. |
| GRAFO-R06 | O watcher despacha o nó que está no estado da Run; não consulta o grafo para escolher o próximo. A transição gravada pelo agente não é conferida contra as arestas. | Estado atual; a F2.7 (PRI-394) faz do `graph.yaml` a única fonte e recusa transição fora dele. |
| GRAFO-R07 | Mudança de spec aprovada não é aresta: a Run volta a `plan`, e o que foi produzido antes fica velho (capacidade `spec`). | O como pode precisar mudar; por isso nunca volta direto ao `review`. |
| GRAFO-R08 | O replay reentra em qualquer nó de `plan` a `commit` numa Run nova, reaproveitando os nós anteriores do ciclo parado. | Refazer só o trecho que falhou. |
| GRAFO-R09 | Cada nó tem um comando em `.claude/commands/`, que é o prompt do agente. `implement-step`, `implement-integrate`, `verify-ui` e `init-project` são comandos sem nó: não mudam o nó da Run. | Subtarefa e verificação auxiliar não são etapas do ciclo. |
| GRAFO-R10 | A validação de configuração (capacidade `config`) reprova nó sem comando ou com comando vazio, aresta para nó inexistente, volta sem limite, ciclo nas arestas de avanço e nó sem saída que não seja terminal. | Edição manual do grafo quebrava em silêncio e só aparecia numa Run. |
| GRAFO-R11 | `plan` escolhe o contexto da tarefa pelo índice de specs; os nós seguintes trabalham sobre essa seleção. Só `commit` escreve de forma permanente na memória do consumidor; a exceção é o `implement`, que pode acrescentar em "Decisões de Implementação" da spec da task. | Nenhum nó lê a memória inteira. |

## Invariantes

- GRAFO-I01: toda volta (`on_fail`) tem `max_retries` inteiro maior que zero.
- GRAFO-I02: as arestas de avanço não formam ciclo; só as voltas repetem nó.
- GRAFO-I03: todo nó do arquivo tem comando, e o arquivo do comando existe.
- GRAFO-I04: `implement.md`, `review.md` e `commit.md` têm o conteúdo fixado por hash num teste (`scripts/lib/decomposition-watcher.test.js`); mudar um deles é decisão, não efeito colateral.

## Flags

Nenhuma flag é lida no grafo nem nos comandos. Mudam o caminho de uma Run, a partir de outras
capacidades: `WATCHER_PLAN_IMPLEMENT_CHAIN` (`execucao`, plan e implement no mesmo despacho), a
decomposição do `implement` (`roteamento`) e `PRISMA_UI_VERIFY` (`portoes`). Todas em
[`docs/flags.md`](../flags.md).

## Por onde começar

1. [`.graph/graph.yaml`](../../.graph/graph.yaml): nós, arestas e limites de retry, com o porquê de cada aresta.
2. [`.graph/README.md`](../../.graph/README.md): por que o ciclo é um arquivo e o que cada nó carrega no contexto.
3. [`.claude/commands/implement.md`](../../.claude/commands/implement.md): um nó completo, do contexto de entrada ao que grava.
4. [`scripts/lib/node-events.js`](../../scripts/lib/node-events.js): lê os limites de retry do grafo, com valores de reserva.
5. [`docs/dependency-invalidation.md`](../dependency-invalidation.md): o que volta a ser inválido quando o ciclo recomeça num nó anterior.
