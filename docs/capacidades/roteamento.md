---
id: roteamento
tipo: capacidade
resumo: Escolhe modelo e esforço por Attempt e decompõe o Implement em subtarefas, com política versionada.
situacao: parcial
spec: sem-spec
flags: [WATCHER_PHASE_EFFORT]
modulos:
  - scripts/lib/model-routing*
  - scripts/lib/routing-*
  - scripts/lib/would-route.js
  - scripts/lib/classifier-*
  - scripts/lib/jev-*
  - scripts/lib/plan-signals.js
  - scripts/lib/plan-paths.js
  - scripts/lib/decomposition-*
  - scripts/lib/subtask-decomposition.js
  - scripts/lib/workspace-manifest.js
  - scripts/lib/phase-effort.js
  - scripts/lib/handoff-lint.js
  - scripts/lib/effort-miss.js
  - scripts/effort-miss*
  - scripts/routing-*
  - scripts/jev-*
---

# Roteamento

O roteamento escolhe o modelo de cada Attempt na admissão da Run e grava a decisão com a política
e o hash que a sustentam. A política é `.claude/model-routing-policy.json` e a ligação por projeto
é `.claude/model-routing.json`, lida só na admissão: `mode` ausente ou `OFF` não muda nada. Aqui o
`mode` está `ON`, como piloto no launcher do próprio Espectro, com `decomposition: off`, e o Jev
classifica em sombra e só registra a opinião. `WATCHER_PHASE_EFFORT` (desligada) fixa o esforço
por fase em `.claude/phase-effort.json`.

## Por onde começar

1. [`scripts/lib/model-routing.js`](../../scripts/lib/model-routing.js): a resolução do §4.7, em funções puras.
2. [`scripts/lib/routing-run.js`](../../scripts/lib/routing-run.js): o snapshot da Run, da admissão até a task.
3. [`scripts/lib/model-routing-policy.js`](../../scripts/lib/model-routing-policy.js): a política versionada e seu hash.
