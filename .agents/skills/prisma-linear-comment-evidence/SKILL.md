---
name: prisma-linear-comment-evidence
description: Comenta em issue PRI do Linear só para registrar decisão ou bloqueio, em 3 linhas (Acordo v2); status vai no topo da issue e evidência no PR. Use quando houver decisão ou bloqueio a registrar.
---

> Skill de produção do Prisma (workflow Cursor); não é runtime do produto; não substitui gates/scripts.

**Faixa de modelo:** leve — sem Opus. Ver `.agents/reference/skill-model-map.md`.

# prisma-linear-comment-evidence

Pelo Acordo v2, comentário **só** para decisão ou bloqueio, em 3 linhas:

```
Decisão|Bloqueio: <o quê>
Por quê / quem decide: <motivo ou pessoa>
Efeito: <o que muda no trabalho>
```

Status (Estado / Próximo passo / Decisão pendente) é editado no topo da descrição, não comentado. Evidência vai na seção Evidência do PR; o comentário pode linkar o PR.

## Proibido

- Fechar issue, mudar status para Done, ou falar em nome do Approval Gate.
- Inferir Focus / Stretch / Uncommitted / Cycle.
- Declarar teste PASS sem evidência; UNKNOWN / ausência de prova ≠ zero ≠ PASS.
- Colar regra de negócio do consumidor ou segredos.
- Comentário de status, de progresso ou de fim de fatia.
- Repetir invariantes ("RC-x NOT APPLIED", "polling não tocado"); ficam nas Agent notes.

## Preferência

1. Um comentário = uma decisão ou um bloqueio.
2. Prova mora no PR (`prisma-evidence-pack` → seção Evidência).

## MCP

Usar o MCP Linear do workspace `prisma-app` / time PRI. Não criar issue nova daqui — isso é `prisma-issue`.
