---
description: Nó "Implement" — executa a mudança usando só o contexto selecionado pelo Plan.
---
> Consumo externo da candidata PRI-60: `PRISMA_ROOT` aponta ao checkout fixado da
> plataforma; cwd/`REPO_PATH` e `memory/` pertencem ao consumidor/worktree.
> Referências a `scripts/`, `templates/`, `.graph/schemas/` e a este template são
> assets da plataforma, resolvidos por `PRISMA_ROOT`; configuração, spec e registros
> históricos continuam no consumidor. Não copiar/reatar estado para corrigir paths.
> Regras, toolchain e repositórios relacionados vêm de `memory/project.yaml` e da
> configuração explícita do consumidor. Exemplos históricos não definem defaults.


Task-id: $ARGUMENTS

Você está executando o nó **Implement**.

## Pré-processamento do contexto (antes de qualquer outro passo)

Procedimento completo, formato e checagens: `templates/context-summarization.md` —
abra-o **só** se a medição do passo 2 der **> limiar**; abaixo disso ele não é usado.

1. Resolva o limiar `context_summarize_threshold_words` sem abrir os arquivos
   inteiros: `grep -m1 '^context_summarize_threshold_words:' memory/project.yaml`;
   se vazio, o valor do `CLAUDE.md` (já carregado na sessão); senão **3000**.
2. Meça: `wc -w < memory/runs/$ARGUMENTS/context.md`.
   - **≤ limiar** (ou arquivo inexistente) → não toque o arquivo; siga para "Passos do nó".
   - **> limiar** → sumarize antes de seguir:
     - copie o original para `context.pre-sumarizacao-<AAAAMMDDTHHMMSSZ>.md`;
     - reescreva `context.md` no formato do template. A linha 1 é o metadado
       `<!-- context-sumarizado: <ts> · nó implement · <N> → <M> palavras · original em context.pre-sumarizacao-<...>.md -->`;
     - **preserve sempre** o objetivo/spec original, as decisões ativas (com motivo),
       tudo que for inviolável/regra de negócio, as tentativas descartadas (com
       motivo), a última falha com os achados na íntegra, o estado atual, os próximos
       passos, e **verbatim** os blocos do watcher (instruções humanas entre `---` e
       o bloco `<!-- spec-validator:avisos:inicio/fim -->`);
     - descarte só o histórico intermediário já refletido no estado atual, logs que
       não causaram falha, e reflexões sobre caminhos nunca tomados;
     - **na dúvida, mantenha**;
     - confira que a linha 1 tem o metadado e que `## Objetivo` e
       `## Decisões ativas` estão presentes e preenchidos. Se não estiverem,
       restaure o original e siga sem sumarizar.
   - Registre `context.md sumarizado <N> → <M> palavras` na entrada do `agent_log`
     deste nó.
3. Continue normalmente em "Passos do nó", usando o `context.md` (sumarizado ou não).

## Passos do nó

0. **Portão de drift da spec** (SPEC = WHAT): antes de qualquer outro passo,
   `node "$PRISMA_ROOT/scripts/lib/spec-authority.js" check memory/runs/$ARGUMENTS --node=implement --write`.
   Exit 3 = a spec mudou depois do Plan sem SPEC_CHANGE aprovado — o comando já
   gravou `status="spec-drift"` no state.json: **pare aqui**, sem implementar e sem
   mexer no `node`/`retries`, e reporte a mensagem. Exit 0 = siga.
1. Leia `memory/runs/$ARGUMENTS/state.json`, `handoff.md` (estado operacional) e
   `plan.md` (o HOW do Plan: passos, arquivos, cobertura dos ACs; run antigo sem
   `plan.md`: a seção `## Plano de execução` do handoff). **Os requisitos funcionais
   vêm da spec** (caminho em `## Referência da Spec` do handoff ou
   `state.json.spec_path`) — leia só as seções que definem o WHAT:
   `sed -n '/^## Critérios de Aceite/,/^## /p;/^## Restrições/,/^## /p' <spec>`.
   `context.md` é histórico/diagnóstico (leia o que precisar), não contrato: se ele
   ou o handoff disserem algo diferente da spec sobre um AC, **a spec vence**.
2. Use SÓ os arquivos listados em `selected_context` — não releia a memória inteira
   do projeto.
   Se existir `memory/runs/$ARGUMENTS/openapi-contract.yaml` (task de endpoint), ele
   é o contrato do endpoint: path, método, campos do DTO/record e status codes
   (`Response.status(...)`/`ResponseFactory.*`) seguem ele. Antes de passar para o
   Review, rode `node "$PRISMA_ROOT/scripts/lib/openapi-validator.js" memory/runs/$ARGUMENTS/openapi-contract.yaml <Resource.java> --md`
   e zere os `[FAIL]`. O contrato é gerado por agente e pode errar: se ele contradiz
   a spec, siga a spec e registre a divergência (campo/status do contrato + motivo)
   em "Decisões de Implementação" (passo 7) — o Review aceita divergência documentada.
   Nunca edite o contrato só para fazer o validador passar.
3. Implemente a mudança dentro do escopo definido pelo Plan. **Toda decisão** que
   tocar a spec (escolha que a spec não fixa, ambiguidade resolvida, desvio do que o
   Plan sugeriu, critério difícil de atender) passa pela governança do passo 3a antes
   de seguir.
3a. **Classifique e registre a decisão** (obrigatório — `scripts/lib/spec-change.js`):

   | Tipo | Quando | Efeito |
   |---|---|---|
   | `TECHNICAL_DECISION` | método interno, query equivalente, helper existente, abordagem técnica — **mesmo** comportamento observável | segue |
   | `SPEC_CLARIFICATION` | a spec era ambígua e a decisão só explicita um comportamento já compatível — **sem** mudar o esperado nem reduzir AC | segue; o Review confere |
   | `SPEC_CHANGE` | remove ou enfraquece AC, altera comportamento esperado, muda regra de negócio, adiciona exceção funcional, altera restrição funcional, expande/reduz escopo funcional | **pausa** — você não aprova |

   Monte o JSON (`node "$PRISMA_ROOT/scripts/lib/spec-change.js" template` imprime o esqueleto) e rode
   `node "$PRISMA_ROOT/scripts/lib/spec-change.js" record memory/runs/$ARGUMENTS --input=<decision.json>`.
   Em `impact`, marque com honestidade cada efeito funcional — **qualquer** flag
   `true` (ou texto que remove/enfraquece AC ou muda regra de negócio) faz o script
   reclassificar como `SPEC_CHANGE`, seja qual for o `type` declarado.
   - exit 0 = `TECHNICAL_DECISION`/`SPEC_CLARIFICATION` gravada em
     `state.json.technical_decisions[]` (`{type, description, rationale, agent, timestamp}`)
     — siga. Nunca edite `technical_decisions[]` à mão.
   - exit 4 = **SPEC_CHANGE**: a proposta (ACs afetados, comportamento anterior,
     proposto, motivo) foi para `spec-change-audit.json`, o state.json ficou
     `status="spec-change-pending-approval"` com `spec_change_pending`, e o handoff
     ganhou o bloco `<!-- spec-change-pending:inicio -->`. **Pare aqui**: não mexa em
     `node`/`retries`/`status`, não edite a spec, não implemente o comportamento novo e
     não rode `/review`. O watcher publica a proposta no Redmine; aprovação humana
     atualiza a spec e devolve a task para o `/plan`. Se houver mais de uma mudança,
     junte-as numa única proposta (o script recusa a segunda enquanto houver uma
     pendente).
   - exit 2 = entrada inválida, nada gravado: corrija e rode de novo.
   - Mudança de AC que a proposta deve aplicar se aprovada vai em `ac_changes`
     (`remove` / `replace` com `text` / `add` com `text`) — o script edita a spec só na
     aprovação, de forma auditável (marca de removido + ID novo + "## Histórico de
     Mudanças"). Você nunca edita Critérios de Aceite, Restrições ou o Histórico.
   - Se a SPEC_CHANGE nasceu de uma mensagem do dev pelo dashboard (human input), ligue-a
     em `human_input_refs` com o `message_hash` (e o `at`) da entrada correspondente de
     `state.json.human_input_interpretations[]` — copie, não invente. Na aprovação isso
     vira provenance `HUMAN_CLARIFICATION` dos ACs tocados (`docs/ac-provenance.md`).
     Citar o human input só no `rationale` não cria vínculo nenhum; sem entrada
     correspondente, deixe `human_input_refs` fora.
   Na dúvida entre `SPEC_CLARIFICATION` e `SPEC_CHANGE`: se alguém que leu só a spec
   poderia esperar outro comportamento observável, é `SPEC_CHANGE`. Se o tipo de mudança
   tiver um subagente correspondente em `memory/project.yaml > agentes_por_dominio`
   (leia só essa seção: `sed -n '/^agentes_por_dominio:/,/^[a-z_]*:$/p' memory/project.yaml`),
   prefira delegar a ele em vez de fazer à mão na sessão principal.
4. Atualize `state.json` pelo `scripts/state-writer.js` (nunca direto): os campos
   de registro abaixo com `node "$PRISMA_ROOT/scripts/state-writer.js" set memory/runs/<task-id> --input=<patch.json>`
   e o nó com `node "$PRISMA_ROOT/scripts/state-writer.js" transition memory/runs/<task-id> --from=implement --to=review`.
   Exit 3 = `STATE_CONFLICT`/`SESSION_CONFLICT` (o run mudou ou outra sessão assumiu — a CLI já re-tentou uma vez quando fazia sentido): pare sem gravar mais nada e reporte. `node="review"` — convenção é sempre "próximo nó a
   rodar" (`history` é quem registra que `implement` rodou, acrescente
   `"implement"` lá) —, atualize `updated_at`, `current_agent="claude"`, e
   acrescente entrada em `agent_log` no formato exato `{"agent": "claude", "nodes": ["implement"], "at": "<ISO-8601 UTC>", "note": "<resumo curto>"}` (`agent` é obrigatório no schema; entrada sem ele faz o watcher marcar a task `state_corrupted` e parar o ciclo).
5. Acrescente ao `context.md` um resumo do que foi de fato alterado e por quê.
6. Reescreva `handoff.md` com o novo estado operacional para o Review,
   preservando o bloco `## Referência da Spec` (Spec / ACs / Plan) sem copiar texto
   de critério. Nunca reescreva o `plan.md` — ele é do Plan.
7. **Spec como contrato vivo.** Ao final da implementação, SE nesta rodada você
   tomou decisão que diverge da spec, resolveu ambiguidade dela ou adicionou
   restrição técnica não prevista — e isso tem impacto em comportamento
   observável —, abra a spec da task (`memory/spec/<ticket>-spec.md`, com
   `<ticket>` = `state.json.redmine_ticket.id`; task sem ticket:
   `memory/spec/$ARGUMENTS-spec.md`) e adicione (APPEND) uma entrada na seção
   `## Decisões de Implementação`, criando-a no fim do arquivo se ainda não
   existir. Formato exato e regras em `templates/spec-decisions-section.md`
   (cabeçalho `### implement · <updated_at> · $ARGUMENTS` + trio
   Decisão/Motivo/Impacto no spec).
   - Só APPEND: nunca reescreva, reordene nem apague nada que já está na spec —
     nem entradas de rodadas anteriores, nem Critérios de Aceite/Restrições.
   - **Decisão não muda AC.** Resolver ambiguidade ou registrar restrição técnica
     é HOW ("Impacto no spec: Nenhum critério alterado — ..."). Entregar um AC
     diferente do que a spec diz é mudar o WHAT: isso é `SPEC_CHANGE` e segue o passo
     3a (proposta + pausa), nunca uma entrada aqui — sem SPEC_CHANGE aprovada por
     humano o Verify reprova (`BEHAVIOR_CHANGE_WITHOUT_APPROVAL`). Prefira implementar
     o AC como está.
   - Não registre refactor interno, nome de variável ou escolha sem efeito
     visível.
   - Se não houve nenhuma dessas situações, **não toque a spec**. Se a spec não
     existir (task ad-hoc sem spec), não crie uma — registre a decisão só no
     `context.md`.
   - Liste as decisões registradas também em `handoff.md` (seção "decisões
     relevantes") para o Review saber que precisa conferi-las.
   - **Decisão técnica que diverge da spec sem mudar comportamento funcional**
     (ex.: estrutura de dados, local da regra, consulta diferente da sugerida na
     spec, com o mesmo resultado observável): é o `TECHNICAL_DECISION` do passo 3a,
     com `ac_affected` preenchido — o registro dele (`ac` + `approved_at`) é o que o
     Review exige para aceitar `DOCUMENTED_TECHNICAL_DECISION`; sem ele, reprova como
     `UNREGISTERED_TECHNICAL_DECISION`. Se a decisão muda comportamento, ela **não** é
     técnica — o Review reclassifica como `SPEC_CHANGE_REQUIRED` e reprova.
   - Rodada de correção depois de reprovação do Review: o bloco
     `<!-- review-findings:inicio -->` do `handoff.md` é o critério de aceite —
     resolva cada achado (categoria, AC, arquivo:linha, esperado, encontrado, ação).
     `SPEC_CHANGE_REQUIRED` não se resolve no código: implemente o AC como a spec diz
     ou registre a mudança como `SPEC_CHANGE` pelo passo 3a (proposta + pausa).

## Se descobrir que o escopo do Plan estava errado
Pare — não force a implementação a caber num escopo errado. Peça correção do Plan
antes de continuar (rode `/plan $ARGUMENTS` de novo com o ajuste).

## Ao terminar
Rode `/review $ARGUMENTS`.
