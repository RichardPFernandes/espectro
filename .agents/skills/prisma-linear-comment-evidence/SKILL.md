---
name: prisma-linear-comment-evidence
description: Comenta em issue PRI do Linear só com links e evidência atribuível (paths, HEAD, comandos, PR/doc/TAP); sem fechar status nem inferir Done/Approval. Use no fim de fatia, bloqueio ou para apontar prova.
---

> Skill de produção do Prisma (workflow Cursor); não é runtime do produto; não substitui gates/scripts.

**Faixa de modelo:** leve — sem Opus. Ver `.agents/reference/skill-model-map.md`.

# prisma-linear-comment-evidence

Comentário Linear **curto**; detalhe fica no artefato linkado. Acionar sob demanda — não canal paralelo de Done/Approval Gate.

## O que pode ir no comentário

- Links: PR, doc Linear, handoff, TAP, path de store/repo, commit/HEAD.
- Comandos realmente executados + resultado observado (ou UNKNOWN).
- Bloqueio/interrupção com próximo passo humano explícito.

## Proibido

- Fechar issue, mudar status para Done, ou falar em nome do Approval Gate.
- Inferir Focus / Stretch / Uncommitted / Cycle.
- Declarar teste PASS sem evidência; UNKNOWN / ausência de prova ≠ zero ≠ PASS.
- Colar regra de negócio do consumidor ou segredos.
- Substituir handoff Maestri (`prisma-handoff`) ou evidência oficial do ciclo.

## Preferência

1. Preferir apontar handoff/doc/PR **já existentes**.
2. Se faltar pacote de prova, usar `prisma-evidence-pack` antes de comentar.
3. Um comentário = um propósito (entrega, bloqueio, ou ponteiro de evidência).

## MCP

Usar o MCP Linear do workspace `prisma-app` / time PRI. Não criar issue nova daqui — isso é `prisma-issue`.
