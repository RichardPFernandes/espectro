---
id: grafo
tipo: base
resumo: Define o ciclo da Run como grafo de nós, com o comando de cada nó e o limite de retry.
situacao: ligada
spec: sem-spec
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
falha (`on_fail`) voltam para `implement` ou `test` e têm `max_retries`; passou do limite, a
Run escala para o humano. O watcher também despacha `implement-step` e `implement-integrate`
(subtarefas do `implement`), e o `verify` chama o `verify-ui`; nenhum dos três é nó do arquivo
do grafo. O `init-project` roda uma vez por projeto, fora do ciclo.

Os schemas de artefato (`acceptance-evidence`, `memory-index`, `spec-changelog`) moram em
`.graph/` e têm esta capacidade como dona. Quem os lê está em outras capacidades; o
`memory-index` não tem leitor neste repo, é do consumidor.

## Por onde começar

1. [`.graph/graph.yaml`](../../.graph/graph.yaml): nós, arestas e limites de retry, com o porquê de cada aresta.
2. [`.graph/README.md`](../../.graph/README.md): por que o ciclo é um arquivo e o que cada nó carrega no contexto.
3. [`.claude/commands/implement.md`](../../.claude/commands/implement.md): um nó completo, do contexto de entrada ao que grava.
4. [`scripts/lib/node-events.js`](../../scripts/lib/node-events.js): lê os limites de retry do grafo, com valores de reserva.
5. [`docs/dependency-invalidation.md`](../dependency-invalidation.md): o que volta a ser inválido quando o ciclo recomeça num nó anterior.
