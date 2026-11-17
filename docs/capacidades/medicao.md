---
id: medicao
tipo: capacidade
resumo: Mede e guarda o que as Runs deixam, como custo por nó, transcrições, comparação de Runs, padrões de falha e rastreio ticket → PR.
situacao: ligada
spec: sem-spec
flags: []
modulos:
  - scripts/lib/cost-tracking.js
  - scripts/lib/claude-usage.js
  - scripts/lib/transcript-writer.js
  - scripts/lib/run-comparator.js
  - scripts/compare-runs.js
  - scripts/lib/knowledge-graph.js
  - scripts/trace.js
  - scripts/memory-consolidator.js
---

# Medição

Depois de cada despacho, o watcher grava em `state.cost_tracking` o custo e a duração do nó,
e copia a transcrição do agente para a pasta da Run. Token que o agente não reportou fica
`null`, nunca 0. O `knowledge-graph.js` liga ticket, spec e PR, e o `trace.js` responde, para
um arquivo, quais tickets o tocaram. O `memory-consolidator.js` resume as falhas recorrentes
em `memory/patterns.md`, e o `run-comparator.js` compara duas Runs.

As transcrições têm conteúdo sensível e ficam só em disco local. `TRANSCRIPTS_DISABLED=true`
desliga a gravação; essa flag é lida no `readmine-watcher.js`, da capacidade `ciclo-da-run`.
Todas as flags estão em [`docs/flags.md`](../flags.md).

## Por onde começar

1. [`scripts/lib/cost-tracking.js`](../../scripts/lib/cost-tracking.js): a regra de `null` e a soma por nó.
2. [`scripts/lib/transcript-writer.js`](../../scripts/lib/transcript-writer.js): a transcrição por nó e o índice.
3. [`scripts/lib/knowledge-graph.js`](../../scripts/lib/knowledge-graph.js): os nós e as arestas ticket → spec → PR.
4. [`scripts/lib/run-comparator.js`](../../scripts/lib/run-comparator.js): comparação de custo e de resultado entre Runs.
5. [`scripts/memory-consolidator.js`](../../scripts/memory-consolidator.js): padrões de falha do histórico.
