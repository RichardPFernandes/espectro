---
name: prisma-ac-rn-map
description: Guia mapeamento AC (change) → RN (capability) em modo Candidate com coluna UNKNOWN explícita. Use em ensaios SDD por capability (ex. PRI-132 H1+). Não promove Active nem escreve log.json.
---

> Skill de produção do Prisma (workflow Cursor); não é runtime do produto; não substitui gates/scripts.

# prisma-ac-rn-map

Complemento de `prisma-sdd-discipline` (ler aquela skill primeiro). Só **Candidate** — sem promoção Active, sem `log.json`, sem fechar H4.

## Tabela de saída

| AC (change) | RN candidata (capability) | Fonte | UNKNOWN? | Nota |
| --- | --- | --- | --- | --- |
| AC-NN do ticket/spec | regra permanente proposta | A/B/C… | sim/não | — |

- **AC** = critério da *change* (ticket/spec); IDs locais — `AC-01` **não** deduplica entre changes.
- **RN** = regra permanente da *capability*; código/UI ≠ RN aprovado automático.
- Sem fonte nomeada → coluna UNKNOWN preenchida; não inventar Decision.

## Pode

- Mapear e listar perguntas humanas (próximo ID / se AC vira RN ou não).
- Apontar `docs/spec-guide.md`, ensaios PRI-132/174, disciplina Native vs Self-SDD.
- Manter lista **fora** do Linear quando for regra de negócio do consumidor.

## Proibido

- Publicar RN/negócio do consumidor no Linear sem autorização.
- `sdd-create`/`sdd-update`, Active, `log.json`, H4, RRC, Freeze.
- Tratar mapa Candidate como spec aprovada ou Approval Gate.

## Saída típica

Mapa + UNKNOWNs + 1–3 perguntas para o humano. Nada promovido.
