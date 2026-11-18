---
id: ferramentas
tipo: capacidade
resumo: Scripts offline fora do caminho da Run, como demo, sondas, limpeza, exportadores, validadores de processo e o próprio mapa.
situacao: ligada
spec: sem-spec
flags: []
modulos:
  - scripts/capability-map.js
  - scripts/demo.js
  - scripts/probes/*
  - scripts/harness/*
  - scripts/cli-proof-inventory.js
  - scripts/lib/cli-proof-inventory.js
  - scripts/run-*
  - scripts/lib/lint-baseline.js
  - scripts/lib/roadmap-*
  - scripts/cleanup-*
  - scripts/obsidian-export.js
  - scripts/export-runs.js
  - scripts/lib/runs-exporter.js
  - scripts/validate-handoff.js
  - scripts/return-point.js
  - scripts/lib/maestro-guard-pre-done.js
  - scripts/src/platform/marker.js
---

# Ferramentas

Scripts que o dev ou o CI chamam à mão e que nenhum nó da Run precisa para andar: o `demo.js`
(ciclo simulado, sem credencial nem rede), as sondas e o harness, os exportadores, os
validadores (`validate-handoff.js`, `roadmap-lint.js`), o gerador da página do roadmap
(`roadmap-site.js`) e este mapa. A exceção é a limpeza de Runs: o watcher chama
`cleanup-runs.js` ao subir, e `DISABLE_AUTO_CLEANUP=true` desliga isso. Se um script daqui passar a ser chamado por um nó, ele muda de capacidade.

## Por onde começar

1. [`scripts/demo.js`](../../scripts/demo.js): o ciclo simulado de `npm run demo`.
2. [`scripts/capability-map.js`](../../scripts/capability-map.js): este mapa, com `--check` e `--of`.
3. [`scripts/cleanup-runs.js`](../../scripts/cleanup-runs.js): rotação de Runs antigas, que só move.
