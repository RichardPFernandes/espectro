# Playbook da esteira Cursor (plataforma Prisma)

Skills obrigatórias por ação da **esteira de desenvolvimento**. Path: `.agents/skills/<nome>/SKILL.md`. Skill orienta; script/contrato decide. Não é runtime do produto / watcher.

## Ação → skill

| # | Ação | Skill | Faixa (mapa) |
| ---: | --- | --- | --- |
| 1 | Abrir / continuar issue PRI | `prisma-issue` | médio |
| 2 | Planejar fatia sem watcher | `prisma-plan-lite` | médio |
| 3 | Impacto além da baseline / Freeze | `prisma-reconciliation-nav` | médio / pesado se fora |
| 4 | Auditar SDD Candidate | `prisma-sdd-discipline` | médio / leve checklist |
| 5 | Mapear AC → RN | `prisma-ac-rn-map` | médio / pesado se denso |
| 6 | Editar código | — | médio / pesado estrutural |
| 7 | Receita oficial de testes | `prisma-tests` | **leve** |
| 8 | Pacote de prova → seção Evidência do PR | `prisma-evidence-pack` | **leve** |
| 9 | Body de PR | `prisma-pr-describe` | **leve** |
| 10 | Comentário de decisão ou bloqueio (3 linhas) | `prisma-linear-comment-evidence` | **leve** |
| 11 | Transferência pedida pelo coordenador Maestri (opcional no Acordo v2) | `prisma-handoff` | leve / médio se BLOCKED |
| 12 | Docs negócio + técnica | `prisma-docs-humano` | **leve** |

**Regra:** ao iniciar a ação, **carregar** a skill. Não é “se lembrar”.

## Referências (esteira)

| Doc | Quando |
| --- | --- |
| [../reference/skill-model-map.md](../reference/skill-model-map.md) | Escolher faixa / modelo |
| [../reference/subtask-routing.md](../reference/subtask-routing.md) | **Nascimento** de subtarefa/worker (antes do spawn) |
| [../reference/context-packing.md](../reference/context-packing.md) | O que incluir no contexto da sessão |
| [../reference/orchestration-patterns.md](../reference/orchestration-patterns.md) | Fan-out, research isolation, anti persona→persona |
| [../reference/skill-anatomy.md](../reference/skill-anatomy.md) | Editar/criar skills (rationalizations / red flags) |

## Plataforma vs consumidor

Estes artefatos são do **bootstrap Prisma**. Em projetos consumidores onde o Prisma for inserido, a esteira vale como procedimento da plataforma. **Não** criar aqui config/estado/credenciais do app consumidor.

## Fora deste playbook

- Ciclo automático do produto (watcher / Attempt / S4)
- `npx skills add` em massa / pacote Addy inteiro
- Definition of Done genérico como gate
- C1 PRI-181 / Authority Runtime
