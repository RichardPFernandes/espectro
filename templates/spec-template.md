---
ticket: {{TICKET_ID}}
draft: {{DRAFT}}
generated_from_ticket: {{GENERATED_FROM_TICKET}}
generated_at: {{GENERATED_AT}}
---
<!--
  LEGADO: spec nova começa de templates/spec.md.template (guia: docs/spec-guide.md).
  Este formato continua sendo o do rascunho automático do watcher (spec-generator.js)
  e o de specs anteriores ao template, que não precisam ser migradas.

  Template de spec — memory/spec/<ticket>-spec.md. É o formato que o portão de spec
  do watcher (scripts/lib/spec-validator.js) valida antes do /plan: ## Problema (ou
  ## Contexto), ## Solução e ## Critérios de Aceite (mínimo 2 itens em lista) são
  obrigatórias; Restrições, Arquivos Afetados e Dependências são recomendadas.

  Preenchimento automático: scripts/lib/spec-generator.js (generateSpecDraft) troca
  cada {{PLACEHOLDER}} pelo campo correspondente do ticket Redmine. Mapeamento campo
  → seção está no comentário de cada seção. Spec gerada sai com `draft: true` no
  frontmatter: o watcher NÃO inicia ciclo enquanto essa linha existir — revise o
  conteúdo e troque para `draft: false` (ou apague a linha) para liberar o ciclo.

  Preenchimento manual: copie este arquivo, substitua os {{PLACEHOLDER}} à mão e
  apague o frontmatter (ou use `draft: false`). Comentários HTML não contam como
  conteúdo para o validador — podem ficar.
-->
# Ticket #{{TICKET_ID}} — {{SUBJECT}}

## Problema
<!-- Redmine: `description` (texto fora das subseções Solução/Critérios/Restrições/
     Arquivos Afetados/Dependências, que vão para as seções de mesmo nome abaixo).
     Situação atual: o que acontece hoje, quem é afetado e por que precisa mudar. -->
{{PROBLEMA}}

## Módulo Afetado
<!-- Redmine: `category` → módulo. Microsserviços inferidos do nome da categoria
     (ex: "Pedidos" → ms-pedidos; override em SPEC_CATEGORY_SERVICE_MAP). É palpite
     para o /plan confirmar, não fato. -->
- Categoria (Redmine): {{REDMINE_CATEGORY}}
- Microsserviços inferidos: {{MICROSERVICES}}

## Versão Alvo / Restrições de Deploy
<!-- Redmine: `fixed_version` (Versão prevista / target_version). Se houver janela de
     deploy, cliente específico ou dependência de release, descreva aqui. -->
- Versão alvo: {{TARGET_VERSION}}

## Solução
<!-- Comportamento esperado depois da entrega (o quê, não necessariamente o como).
     Preenchido só se a descrição do ticket tiver uma subseção "Solução" — nunca
     inventado. -->
{{SOLUCAO}}

## Critérios de Aceite
<!-- Mínimo 2 itens em lista ("-"), cada um com ID estável: "- AC-01: <critério>",
     "- AC-02: ...", em sequência, sem pular nem repetir (scripts/lib/ac-ids.js). Como o
     QA vai verificar a entrega. Preenchido só se a descrição do ticket tiver uma
     subseção "Critérios de Aceite" — o gerador numera, nunca inventa.
     A spec é a autoridade sobre O QUÊ entregar: o Plan cita estes IDs em cada passo,
     o state.json guarda só os IDs (ac_ids). ID dado é para sempre: critério novo
     ganha o próximo número; critério que deixou de valer NÃO é apagado — fica com
     "(removido em <data>: motivo)"; nota/detalhe vai em sub-item indentado. -->
{{CRITERIOS_ACEITE}}

## Restrições
<!-- O que NÃO pode mudar ou quebrar. Ver também memory/project.yaml >
     regras_invioláveis. -->
{{RESTRICOES}}

## Arquivos Afetados
<!-- Telas, endpoints, módulos ou arquivos já conhecidos. -->
{{ARQUIVOS_AFETADOS}}

## Dependências
<!-- Outros tickets, repos (app-front, app-core, mo-entity), dados ou acessos. -->
{{DEPENDENCIAS}}

## Sugestão de Granularidade do Plan
<!-- Redmine: `estimated_hours` → quantos passos o /plan deveria quebrar a tarefa.
     Sugestão, não regra: o /plan decide depois do diagnóstico. -->
- Estimativa (Redmine): {{ESTIMATED_HOURS}}
- Sugestão: {{PLAN_GRANULARITY}}

## Responsável
<!-- Redmine: `assigned_to`. -->
- {{ASSIGNED_TO}}
