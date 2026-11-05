---
name: prisma-plan-lite
description: >-
  Checklist curto do /plan (escopo, sizing XS–M, AC+verificação, checkpoints,
  riscos de contrato) para planejamento interativo Cursor sem watcher. Use
  antes de editar em fatias fora do despacho; use when a fatia parece grande
  demais, falta critério de aceite por passo, ou o plano precisa sobreviver
  a troca de sessão/worker.
---

> Skill de produção do Prisma (workflow Cursor); não é runtime do produto; não substitui gates/scripts.
> Vive no bootstrap da **plataforma** (`.agents/skills/`); viaja com o Prisma inserido em consumidores — não inventa config/estado do consumidor.

**Faixa de modelo:** médio — preferir Sonnet. Opus só se aparecer Freeze. Ver `.agents/reference/skill-model-map.md`.

# prisma-plan-lite

Espelho **curto** do checklist do `/plan` (`.claude/commands/plan.md`) para sessão **interativa sem watcher**. **Não** substitui o nó despachado; o comando oficial continua a autoridade do HOW no ciclo.

Padrões adaptados (esteira, não Authority): fatia vertical, sizing XS–M, AC+verificação por subtarefa, checkpoints, anti-racionalização. Ver também [`.agents/reference/context-packing.md`](../../reference/context-packing.md) e [`.agents/reference/orchestration-patterns.md`](../../reference/orchestration-patterns.md).

## Checklist (entregar antes de editar)

1. **WHAT vs HOW** — Spec/issue = WHAT; este plano = HOW. Não criar/remover/reescrever AC.
2. **Escopo** — pacotes/arquivos que mudam e os que **não** podem (`scripts/`, `dashboard/`, `harness/`, `templates/`, `docs/`, `.graph/`). Separar **plataforma** (este bootstrap) de **config/estado do consumidor** (AGENTS.md §4/§6) — não inventar o segundo.
3. **Baselines** — apontar `AGENTS.md`, docs/provenance citados; impacto além da baseline → `prisma-reconciliation-nav`, não “absorver” aqui.
4. **Riscos de contrato** — `state-writer`, schemas, proveniência, writers, estado autoritativo.
5. **Quebra + sizing** — fatia vertical; subtarefas XS–M; L+ quebrar (abaixo).
6. **Passos + evidência** — cada passo com AC testável + comando/prova; UNKNOWN permanece UNKNOWN.
7. **Checkpoints** — a cada 2–3 subtarefas; OK humano antes de editar / avançar fase.
8. **Fora** — OpenAPI extraído do plan (PRI-193), `sdd-update`/mutação de spec, SPEC_CHANGE sem humano; Authority Runtime / S4; C1 PRI-181.

## Fatia vertical (não horizontal)

Preferir um caminho ponta a ponta testável por subtarefa — não “todo o schema, depois toda a API”.

| Ruim (horizontal) | Bom (vertical) |
| --- | --- |
| 1) Todo schema 2) Todas APIs 3) Toda UI | 1) Um fluxo completo mínimo 2) Próximo fluxo |

## Sizing (XS–M; L+ quebrar)

| Size | Arquivos (ordem) | Regra |
| --- | --- | --- |
| **XS** | 1 | Função/config pontual |
| **S** | 1–2 | Um componente/endpoint/skill |
| **M** | 3–5 | Uma fatia de feature |
| **L / XL** | 5+ | **Quebrar** antes de despachar |

Quebrar também se: não cabe em uma sessão focada; AC não cabe em ≤3 bullets; toca dois subsistemas independentes; o título tem “e” juntando trabalhos distintos.

Template por subtarefa: [`references/task-template.md`](./references/task-template.md).

## Checkpoints e plano incompleto

- Inserir checkpoint a cada 2–3 subtarefas (testes/receita pertinentes + “revisar com humano se risco de contrato”).
- **Nunca sobrescrever plano incompleto de outra fatia** (tracker/Project, handoff, ou doc de plano) para “abrir espaço”. Mesma fatia revisada → atualizar no lugar; fatia diferente → parar e perguntar.
- Lista de tarefas: usar o **tracker já designado** (Project / Linear / handoff) — **não** criar `tasks/todo.md` paralelo se o ambiente já tem lista autoritativa.

## Regras

- Esperar **OK humano** antes de editar.
- Sem subagente Explore “pra conhecer o repo”; comprimir leitura como o `/plan` (ver context-packing).
- Sem avançar grafo / gravar `state.json` / rodar `invalidate.js` só porque planejou.
- Se a fatia for ticket com run despachado, preferir o nó `/plan` oficial — esta skill é para produção Cursor fora do watcher.
- Ao despachar workers a partir do plano: seguir [`.agents/reference/subtask-routing.md`](../../reference/subtask-routing.md) (ação → skill → faixa).

## Common Rationalizations

| Racionalização | Realidade |
| --- | --- |
| “Vou descobrindo na implementação” | Plano curto evita retrabalho e fatia monstro; 10 min aqui economizam sessão cara. |
| “Os passos são óbvios” | Escrever AC+verificação revela dependência e buraco de prova. |
| “Sizing é burocracia” | L+ sem quebra = worker herda Opus/contexto e falha no meio. |
| “O plano antigo está stale, apago” | Itens unchecked podem estar mid-build noutro worker — parar e perguntar. |
| “Crio `tasks/todo.md` além do tracker” | Segundo roteiro compete com Project/Linear; indexar o tracker existente. |

## Red Flags

- Começar a editar sem plano escrito com AC por passo.
- Subtarefas sem verificação / só “implementar a feature”.
- Todas as tarefas L/XL.
- Sem checkpoint entre fases.
- Plano que mistura plataforma com config/credencial/estado de consumidor.
- Despacho de worker sem `skill`+`faixa` no brief.

## Verification

Antes de pedir OK para editar:

- [ ] WHAT intacto (sem reescrever AC da issue)
- [ ] Cada subtarefa ≤ M, com AC + verificação
- [ ] Ordem/deps explícitas; checkpoints a cada 2–3 passos
- [ ] Riscos de contrato e out-of-scope listados
- [ ] Nenhum plano incompleto alheio foi sobrescrito
- [ ] “Aguardando OK humano para editar”

## Saída típica

Resumo: objetivo · escopo in/out · sizing/subtarefas · riscos · passos testáveis · checkpoints · perguntas UNKNOWN · “aguardando OK para editar”.
