---
id: spec
tipo: capacidade
resumo: Gera, valida, versiona e invalida a spec de cada ticket, que é a fonte dos critérios de aceite.
situacao: ligada
spec: sem-spec
flags: []
modulos:
  - scripts/lib/spec-*
  - scripts/lib/ac-*
  - scripts/invalidate.js
  - scripts/rebuild-ac-registry.js
---

# Spec

A spec de ticket (`memory/spec/<ticket>-spec.md`, no consumidor) diz **o que** entregar; o plano
diz **como**. O `spec-generator.js` monta o rascunho a partir dos campos do ticket do Redmine, o
`spec-validator.js` barra a spec incompleta antes do Plan e o `spec-repairer.js` sugere as seções
que faltam, sem escrever na spec. Depois da aprovação, `spec-version.js` e `spec-hash.js` fixam a
versão e o hash do contrato; uma mudança aprovada passa por `spec-change.js` e o `invalidate.js`
marca como velho tudo o que foi produzido antes. Os IDs de AC ficam em `ac-ids.js` e no registro.

`SPEC_DRAFT_AUTOGEN` e `SPEC_AUTO_REPAIR` (ligadas por padrão, `0` desliga) são lidas no
`readmine-watcher.js`, da capacidade `ciclo-da-run`; todas as flags estão em
[`docs/flags.md`](../flags.md).

## Por onde começar

1. [`scripts/lib/spec-authority.js`](../../scripts/lib/spec-authority.js): SPEC = WHAT, PLAN = HOW, e quem pode citar a spec.
2. [`scripts/lib/spec-version.js`](../../scripts/lib/spec-version.js): `spec_version` e `spec_hash`; o ciclo de vida está em `docs/spec-versioning.md`.
3. [`scripts/lib/spec-validator.js`](../../scripts/lib/spec-validator.js): o portão de qualidade da spec.
4. [`scripts/invalidate.js`](../../scripts/invalidate.js): o que fica inválido quando o contrato muda (`docs/dependency-invalidation.md`).
5. [`scripts/lib/ac-registry.js`](../../scripts/lib/ac-registry.js): registro consultável dos critérios de aceite.
