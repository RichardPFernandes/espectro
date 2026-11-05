---
name: prisma-issue
description: Abre ou continua trabalho a partir de uma issue PRI-NNN do Linear no repositório Prisma — lê issue, handoff e baselines, delimita escopo e arquivos e propõe um plano antes de editar. Use quando o usuário citar uma issue PRI ou pedir para começar uma tarefa no Prisma.
disable-model-invocation: true
---

> Skill de produção do Prisma (workflow Cursor); não é runtime do produto; não substitui gates/scripts.

**Faixa de modelo:** médio — preferir Sonnet (planejar com qualidade). Opus só se arquitetura/Freeze. Ver `.agents/reference/skill-model-map.md`.

# prisma-issue

Ponto de partida de uma sessão **interativa** no Prisma. Só lê e planeja; não edita código nem estado operacional até aprovação explícita do plano.

## Passos

1. Leia `AGENTS.md`. Se existir no checkout, leia também `.cursor/rules/interactive-boundary.mdc` (fronteira interativa; ausente no `main` cloud até promoção separada).
2. Pelo MCP Linear do workspace Prisma (`prisma-app` / time PRI), recupere a issue informada (ex.: `PRI-168`), comentários, relações e handoff anexado, se houver.
3. Antes de **criar** issue nova: busque equivalente já existente; não gere uma tarefa por ação técnica.
4. Classificação Linear (política do time, não inventar):
   - um único Work Type: Planning, Architecture, Audit, Implementation, Validation ou Governance;
   - templates nativos via `list_templates` / `get_template`; se a lista vier vazia, use o documento canônico «Template de Issue — Prisma» e **não** invente template id nem passe id de documento em `template`;
   - **não** atribuir Focus, Stretch, Uncommitted ou Cycle por inferência;
   - labels complementares (Bug, Feature, Improvement, Approval Gate) só quando a política já as usar.
5. Identifique baselines e decisões citadas e abra as que existirem no repo (`provenance/`, `docs/`, `.graph/`).
6. Entregue um resumo curto:
   - objetivo e critérios de aceite da issue;
   - escopo: arquivos e pacotes (`scripts/`, `dashboard/`, `harness/`, `templates/`, `docs/`) que devem mudar e os que não podem;
   - riscos de contrato (schemas em `.graph/schemas/`, `state-writer.js`, proveniência);
   - plano em passos pequenos, cada um com o teste que o comprova.
7. Sugira a branch no padrão do projeto (ex.: `fernandesrichard312/pri-NNN-<slug>` ou `cursor/<slug>-…`) a partir de `main`, conforme o fluxo da sessão.
8. Pare e espere aprovação do plano antes de editar.

## Execução após aprovação

Para uma implementação aprovada, conclua o ciclo aplicável — Implement → Review independente → Test → Verify → Commit. A aprovação do plano autoriza os commits e o push necessários para abrir ou atualizar um PR da tarefa; faça isso quando o repositório e o fluxo da tarefa suportarem PR. Se não houver mudança ou PR aplicável, registre o motivo no resultado.

Não faça merge, deploy nem avance o status da issue no Linear sem pedido explícito. Se o trabalho sair do escopo aprovado, pare e apresente o novo escopo antes de continuar.

## Links canônicos (Linear)

- Política Work Type / Cycle: https://linear.app/prisma-app/document/prisma-politica-de-classificacao-e-modelos-de-issue-work-type-cycle-e033efdc5090
- Template de Issue — Prisma: https://linear.app/prisma-app/document/template-de-issue-prisma-5585827bdb94

## Fora do escopo

- Avançar nó do grafo, gravar `state.json`, `spec_hash`, aprovação, invalidação, lock ou handoff oficial do ciclo.
- Rodar `scripts/state-writer.js` ou `scripts/invalidate.js` contra um consumidor.
- Merge, deploy ou mudança de status da issue no Linear sem pedido explícito.
- Duplicar esta skill em `.cursor/rules/linear-workflow.mdc` (já rejeitado).
- Substituir gates, Freeze, RRC, Active ou H4.
