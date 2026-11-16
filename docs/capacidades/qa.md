---
id: qa
tipo: capacidade
resumo: Trata a recusa de QA do Redmine, com ciclo próprio, devolução sem código e diagnóstico atrás de flag.
situacao: parcial
spec: sem-spec
flags: []
modulos:
  - scripts/lib/qa-*
---

# QA

Quando o QA recusa um ticket, a recusa vira uma entrada em `state.qa_rejections[]`, com ciclo
separado do ciclo principal. O `qa-rejection-ingest.js` a ingere de forma idempotente e o
`qa-rejection-identity.js` calcula a identidade dela. O `qa-cycles.js` alimenta o dashboard,
e o `qa-handback.js` devolve ao QA sem despachar agente, quando o problema foi resolvido fora do
código, como um SQL aplicado no banco.

O diagnóstico da recusa (`qa-diagnosis-*`: modelo, store, protocolo, predicados, regras e
taxonomia) está atrás de `WATCHER_QA_DIAGNOSTICO`, desligada por padrão. Por padrão uma recusa com
run anterior espera o botão "Corrigir recusa QA" do dashboard e reaproveita o task-id;
`WATCHER_RECUSA_QA_NOVO_CICLO=1` volta a abrir ciclo novo sozinho. As duas flags são lidas no
`readmine-watcher.js`, por isso não entram em `flags`.

## Por onde começar

1. [`scripts/lib/qa-rejection-ingest.js`](../../scripts/lib/qa-rejection-ingest.js): como a recusa entra, sem duplicar.
2. [`scripts/lib/qa-cycles.js`](../../scripts/lib/qa-cycles.js): o ciclo de cada recusa e o que o dashboard mostra.
3. [`scripts/lib/qa-handback.js`](../../scripts/lib/qa-handback.js): devolver ao QA sem código.
4. [`scripts/lib/qa-diagnosis-protocol.js`](../../scripts/lib/qa-diagnosis-protocol.js): o protocolo do diagnóstico.
5. [`scripts/lib/qa-diagnosis-model.js`](../../scripts/lib/qa-diagnosis-model.js): o Diagnosis Record.
