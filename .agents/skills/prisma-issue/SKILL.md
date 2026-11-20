---
name: prisma-issue
description: Abre, cria ou continua trabalho a partir de uma issue PRI-NNN do Linear no repositório Prisma, no formato do Acordo v2 — lê o bloco de Estado, o nível e as Agent notes, delimita escopo e arquivos e propõe um plano antes de editar. Use quando o usuário citar uma issue PRI, pedir para começar uma tarefa no Prisma ou para abrir issue nova.
disable-model-invocation: true
---

> Skill de produção do Prisma; não é runtime do produto; não substitui gates/scripts.

**Faixa de modelo:** médio — preferir Sonnet (planejar com qualidade). Opus só se arquitetura/Freeze. Ver `.agents/reference/skill-model-map.md`.

# prisma-issue

Ponto de partida de uma sessão **interativa** no Prisma. Só lê e planeja; não edita código nem estado operacional até aprovação do plano. Regras curtas: topo do `CLAUDE.md` (Acordo v2).

## Passos

1. Leia `CLAUDE.md` e `AGENTS.md`. Se existir no checkout, leia também `.cursor/rules/interactive-boundary.mdc`.
2. Pelo MCP Linear do workspace Prisma (`prisma-app` / time PRI), recupere a issue (ex.: `PRI-168`): bloco de Estado no topo, Agent notes, relações e comentários de decisão ou bloqueio.
3. **Nível** (grupo de rótulos `Processo`: Leve, Médio ou Alto; seleção única):
   - sem rótulo, **pare e pergunte**, com recomendação de nível e o motivo numa linha;
   - nível pelo efeito: atrás de flag desligada é Médio; mudar o que já roda no consumidor (ligar flag, bump, polling, operação protegida, credencial) é Alto; docs, avaliações, ferramentas offline e testes são Leve;
   - se o trabalho passar do nível, peça reclassificação ao Richard. Não crie adendo.
4. Antes de **criar** issue nova: busque equivalente já existente; não gere uma tarefa por ação técnica.
5. Classificação Linear (política do time, não inventar):
   - um único Work Type: Planning, Architecture, Audit, Implementation, Validation ou Governance;
   - **não** atribuir Focus, Stretch, Uncommitted ou Cycle por inferência;
   - labels complementares (Bug, Feature, Improvement, Approval Gate) só quando a política já as usar.
6. Identifique baselines e decisões citadas e abra as que existirem no repo (`provenance/`, `docs/`, `.graph/`).
7. Entregue um resumo curto: objetivo e ACs; nível (com o motivo); escopo (arquivos que mudam e os que não podem); riscos de contrato (`.graph/schemas/`, `state-writer.js`, proveniência); plano em passos pequenos, cada um com o teste que o comprova.
8. Sugira a branch no padrão do projeto (ex.: `fernandesrichard312/pri-NNN-<slug>`) a partir de `main`.
9. Pare e espere aprovação do plano antes de editar.

## Formato da issue (templates "Processo Leve/Médio/Alto")

Ao criar issue, use o template do nível (`list_templates` no time Prisma-app: "Processo Leve", "Processo Médio" ou "Processo Alto"), que já aplica o rótulo. Se a lista vier vazia, escreva o mesmo formato à mão:

```markdown
**Estado:** <uma frase>

**Próximo passo:** <quem faz o quê>

**Decisão pendente:** <pergunta + recomendação + prazo (próxima segunda/quinta)> | nenhuma

**Ligado ao fechar:** <sim — onde | não — por quê> (preencher no Done)

**Nível:** Leve|Médio|Alto — <motivo em uma linha>

## Objetivo
<o que muda e para quem>

## Escopo
* <item>

## Fora de escopo
* <item>

## ACs
- [ ] AC-1 <verificável>

## Pronto quando
<o que fica ligado ou demonstrável; se ficar atrás de flag, quando ela liga>

+++ Agent notes

Arquivos prováveis, plano curto, referências. Invariantes que se aplicam, listadas uma vez aqui.
SPEC: Médio só se precisar (até 1 página); Alto, 1 a 2 páginas, em `tasks/<id>/SPEC.md`.

+++
```

No Alto, acrescente "Riscos e rollback" e "Dependências", e a Decisão pendente exige AUTORIZO explícito.

## Status, comentários e evidência

- **Status mora no topo.** Atualize Estado / Próximo passo / Decisão pendente no lugar (`save_issue` com `patch`). Não poste status em comentário.
- **Comentário só para decisão ou bloqueio**, em 3 linhas: `Decisão|Bloqueio` / `Por quê ou quem decide` / `Efeito`.
- **Evidência no PR**, na seção Evidência do `.github/pull_request_template.md`. Não há `evidence-*.md`, `handoff-*.yaml` nem adendo de SPEC.
- Não repita invariantes ("RC-x NOT APPLIED", "polling não tocado") fora das Agent notes.

## AUTORIZO e perguntas

- **AUTORIZO por lote.** Procure o comentário do Richard que autoriza o milestone em lote. Ele libera fatias leves e médias do milestone, nos limites escritos nele. Fatia alta precisa de AUTORIZO próprio; bump e ligar flag são Alto e o merge é sempre do Richard.
- **Perguntas.** Pare só quando mudar o escopo, faltar acesso/credencial ou a ação não tiver volta, sempre com recomendação. As demais vão para "Decisão pendente" (janela de segunda ou quinta). Leve/Médio: sem objeção até a janela, vale a recomendação. Alto: resposta explícita.

## Execução após aprovação

Implement → Review → Test → Verify → Commit. Revisão: Leve = 1; Médio = 1 G3; Alto = 1 rodada G3 com 2 revisores (segunda rodada só com decisão do Richard). A aprovação do plano autoriza os commits e o push para abrir ou atualizar o PR **draft** da tarefa, com rótulo `processo:leve|medio|alto` e "Refs PRI-NNN" (nunca "Fixes").

Não faça merge, deploy nem mova a issue para Done. Done só com a Evidência do PR e o aceite do Richard; pai não fecha com filha aberta.

## Links canônicos (Linear)

- Acordo de desenvolvimento (v2): https://linear.app/prisma-app/document/prisma-acordo-de-desenvolvimento-62a84790f75a
- Política Work Type / Cycle: https://linear.app/prisma-app/document/prisma-politica-de-classificacao-e-modelos-de-issue-work-type-cycle-e033efdc5090

## Fora do escopo

- Avançar nó do grafo, gravar `state.json`, `spec_hash`, aprovação, invalidação ou lock do ciclo.
- Rodar `scripts/state-writer.js` ou `scripts/invalidate.js` contra um consumidor.
- Merge, deploy ou Done no Linear.
- Substituir gates, Freeze, RRC, Active ou H4.
