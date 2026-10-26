---
name: prisma-reconciliation-nav
description: Aponta quando impacto além da baseline exige reconciliação / Architecture Change Candidate; RRC-F31-001/002 NOT APPLIED. Use antes de propor mudança estrutural ou além do Freeze. Não aprova nem aplica RRC.
---

> Skill de produção do Prisma (workflow Cursor); não é runtime do produto; não substitui gates/scripts.

# prisma-reconciliation-nav

Navegação de governança. Skill **não** aprova reconciliação, **não** aplica RRC e **não** reabre Freeze.

## Checklist

1. A mudança cabe na baseline reconciliada (D-F30-01 / `docs/prisma/architecture-baseline.md`)?
2. Se **não**: parar a fatia de implementação; impacto → reconciliação pertinente (AGENTS.md §8).
3. Candidatos **RRC-F31-001/002** continuam **NOT APPLIED** até decisão governada explícita — não “aplicar” daqui.
4. Reabertura pós-Freeze só com razões/evidência do pacote residual (`docs/prisma/residual-gates.md`) + Decision humana — skill só **aponta**.
5. Sem engine/registry/canal paralelo de governança (AGENTS.md §4).

## Ponteiros

- `AGENTS.md` §8
- `docs/prisma/architecture-baseline.md`, `docs/prisma/residual-gates.md`, `docs/prisma/README.md`
- Owners/decisões no Linear (Freeze / F31 / Architecture) — referenciar, não reescrever

## Saída típica

> Fora de escopo desta fatia de código. Próximo artefato humano: Architecture Change Candidate / reconciliação com evidência X. RRC-F31 inalterados. Freeze inalterado.

## Fora do escopo

- Mutualizar spec, writers, Active ou H4 “para contornar” o Freeze.
- Declarar ARCHITECTURE_IMPACT resolvido sem humano.
