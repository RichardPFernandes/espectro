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
3. **Nível de processo** (acordo de desenvolvimento, seção «Níveis de processo» do `AGENTS.md`):
   - leia o rótulo `Processo: leve`, `Processo: médio` ou `Processo: alto` da issue;
   - sem rótulo, atribua o nível pela tabela do `AGENTS.md` e proponha o rótulo no resumo; na dúvida entre dois níveis, use o maior e registre o motivo;
   - o revisor pode subir o nível; descer, só com o Richard. Se o nível subir durante a sessão, registre o motivo na issue e no handoff (`nivel_processo_inicial`, `nivel_processo_motivo`);
   - o nível define o que a sessão exige: leve — sem spec separada, uma revisão simples; médio — spec e implementação na mesma fatia, uma revisão independente; alto — spec fina, revisão G3 independente, AUTORIZO específico, bump e readback.
4. Antes de **criar** issue nova: busque equivalente já existente; não gere uma tarefa por ação técnica.
5. Classificação Linear (política do time, não inventar):
   - um único Work Type: Planning, Architecture, Audit, Implementation, Validation ou Governance;
   - templates nativos via `list_templates` / `get_template`; se a lista vier vazia, use o documento canônico «Template de Issue — Prisma» e **não** invente template id nem passe id de documento em `template`;
   - **não** atribuir Focus, Stretch, Uncommitted ou Cycle por inferência;
   - labels complementares (Bug, Feature, Improvement, Approval Gate) só quando a política já as usar.
6. Identifique baselines e decisões citadas e abra as que existirem no repo (`provenance/`, `docs/`, `.graph/`).
7. Entregue um resumo curto:
   - objetivo e critérios de aceite da issue;
   - nível de processo (lido do rótulo ou atribuído, com o motivo) e o tamanho da fatia (entrega verificável de 3 a 5 dias);
   - escopo: arquivos e pacotes (`scripts/`, `dashboard/`, `harness/`, `templates/`, `docs/`) que devem mudar e os que não podem;
   - riscos de contrato (schemas em `.graph/schemas/`, `state-writer.js`, proveniência);
   - plano em passos pequenos, cada um com o teste que o comprova.
8. Sugira a branch no padrão do projeto (ex.: `fernandesrichard312/pri-NNN-<slug>` ou `cursor/<slug>-…`) a partir de `main`, conforme o fluxo da sessão.
9. Pare e espere aprovação do plano antes de editar.

## AUTORIZO e perguntas

- **AUTORIZO por lote.** Antes de pedir AUTORIZO, procure um comentário do Richard associado ao milestone da issue que autorize o milestone em lote (modelo do acordo: «AUTORIZO o milestone *nome*: implementação com flag desligada e PR em draft. Não inclui bump, merge, ligar flag nem fatias de nível alto.»). Ele libera só as fatias leves e médias do milestone, dentro dos limites escritos no próprio comentário; o que o comentário não cita não está autorizado. Fatia de nível alto continua precisando de AUTORIZO próprio; bump e ligar flag são nível alto e o merge é sempre do Richard, então nenhum deles entra por lote. Cite o comentário (link) no resumo e no handoff; sem comentário aplicável, peça o AUTORIZO específico.
- **Perguntas em lote.** Pergunta não urgente vai para o lote de decisões de segunda e quinta: acumule-a no resumo e, depois do plano aprovado, em um comentário «Para o lote de decisões» na issue (antes da aprovação, esta skill não escreve no Linear), e siga com o que não depende dela. Só é urgente o que bloqueia o trabalho do dia ou traz risco para o consumidor; essa pergunta vai direto ao Richard.

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
