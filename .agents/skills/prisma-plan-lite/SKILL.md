---
name: prisma-plan-lite
description: Checklist curto do que o nó /plan já exige (escopo, arquivos, riscos de contrato, evidência) para planejamento interativo Cursor sem watcher. Use antes de editar em fatias fora do despacho.
---

> Skill de produção do Prisma (workflow Cursor); não é runtime do produto; não substitui gates/scripts.

# prisma-plan-lite

Espelho **curto** do checklist do `/plan` (`.claude/commands/plan.md`) para sessão **interativa sem watcher**. **Não** substitui o nó despachado; o comando oficial continua a autoridade do HOW no ciclo.

## Checklist (entregar antes de editar)

1. **WHAT vs HOW** — Spec/issue = WHAT; este plano = HOW. Não criar/remover/reescrever AC.
2. **Escopo** — pacotes/arquivos que mudam e os que **não** podem (`scripts/`, `dashboard/`, `harness/`, `templates/`, `docs/`, `.graph/`).
3. **Baselines** — apontar `AGENTS.md`, docs/provenance citados; impacto além da baseline → `prisma-reconciliation-nav`, não “absorver” aqui.
4. **Riscos de contrato** — `state-writer`, schemas, proveniência, writers, estado autoritativo.
5. **Passos + evidência** — cada passo com o teste/comando que o comprova; UNKNOWN permanece UNKNOWN.
6. **Fora** — OpenAPI extraído do plan (PRI-193), `sdd-update`/mutação de spec, SPEC_CHANGE sem humano.

## Regras

- Esperar **OK humano** antes de editar.
- Sem subagente Explore “pra conhecer o repo”; comprimir leitura como o `/plan`.
- Sem avançar grafo / gravar `state.json` / rodar `invalidate.js` só porque planejou.
- Se a fatia for ticket com run despachado, preferir o nó `/plan` oficial — esta skill é para produção Cursor fora do watcher.

## Saída típica

Resumo: objetivo · escopo in/out · riscos · passos testáveis · perguntas UNKNOWN · “aguardando OK para editar”.
