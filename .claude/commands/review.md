---
description: Nó "Review" — Spec Compliance + Engineering Review; aresta condicional (PASS nas duas -> Test, senão volta pro Implement).
---
> Consumo externo da candidata PRI-60: `PRISMA_ROOT` aponta ao checkout fixado da
> plataforma; cwd/`REPO_PATH` e `memory/` pertencem ao consumidor/worktree.
> Referências a `scripts/`, `templates/`, `.graph/schemas/` e a este template são
> assets da plataforma, resolvidos por `PRISMA_ROOT`; configuração, spec e registros
> históricos continuam no consumidor. Não copiar/reatar estado para corrigir paths.
> Regras, toolchain e repositórios relacionados vêm de `memory/project.yaml` e da
> configuração explícita do consumidor. Exemplos históricos não definem defaults.


Task-id: $ARGUMENTS

Você está executando o nó **Review**.

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
       `<!-- context-sumarizado: <ts> · nó review · <N> → <M> palavras · original em context.pre-sumarizacao-<...>.md -->`;
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
   Se sumarizou, o trecho do `context.md` no bloco pré-montado é o de antes — vale o
   novo, que você acabou de escrever.

## Orçamento de contexto

Toda leitura fica no contexto e é reenviada em cada turno seguinte. A revisão parte
do **bloco `CONTEXTO PRÉ-MONTADO PELO ORQUESTRADOR`** do prompt — `git diff HEAD` +
arquivos novos de todos os worktrees do ticket, `--stat`, as pré-checagens de secret
(item 1) e lint (item 3) já rodadas, e os 6000 primeiros caracteres do `context.md`.

- **Não rode `git diff` de novo** nem releia os arquivos alterados inteiros: o diff
  está no bloco. Exceção: arquivos listados como "diff omitido por tamanho" — leia
  `git diff HEAD -- <arquivo>` só desses, e só se o checklist exigir.
- **Arquivo completo só quando um item do checklist exigir** (ex.: item 5 precisa
  ver a assinatura inteira do endpoint novo) — e só esse arquivo. Nunca abra
  arquivo não modificado pra "entender o contexto".
- Não releia `context.md` (está no bloco); se precisar de uma seção do fim que
  ficou truncada, `grep -n '^## '` + `sed -n` só dela.
- Sem bloco no prompt (despacho manual): gere o equivalente você mesmo, uma vez —
  `git diff HEAD` + `git ls-files --others --exclude-standard` em cada worktree.

## Passos do nó

Esta sessão já é independente da que implementou (o watcher abre um `claude -p`
novo por nó) — é ela quem revisa. Nunca a mesma sessão que implementou revisando a si
mesma: se você está rodando manualmente na mesma conversa do `/implement`, delegue a
revisão inteira a um subagente passando o diff e o checklist.

O Review avalia **duas dimensões independentes** e dá um veredito para cada uma:

| Dimensão | Pergunta | Fonte da verdade |
|---|---|---|
| **Spec Compliance** | O diff entrega o WHAT da spec — cada AC, Restrições, escopo — sem mudar comportamento não especificado? | Spec da task, na versão do `spec_hash` |
| **Engineering Review** | O diff é seguro e sustentável — checklist técnico de 8 itens? | Diff + pré-checagens do orquestrador |

**Resultado geral = PASS somente quando as duas forem PASS.** As duas dimensões são
avaliadas sempre, mesmo que a primeira já reprove — o Implement precisa de todos os
achados de uma vez, e `failure_origin` só é confiável assim.

Review = avaliação **estática** do diff. Test = avaliação de **execução**. São
complementares, não duplicatas: aqui você não roda a suíte completa nem escreve
teste (isso é do `/test`); roda no máximo os testes **já existentes** das classes
alteradas (item 4).

0. **Portão de drift da spec**: antes de revisar,
   `node "$PRISMA_ROOT/scripts/lib/spec-authority.js" check memory/runs/$ARGUMENTS --node=review --write`.
   Exit 3 = spec mudou depois do Plan sem SPEC_CHANGE aprovado (`status="spec-drift"`
   já gravado): **pare**, sem veredito e sem mexer em `node`/`retries`.
0b. **Validade do implement** (Dependency Invalidation — `docs/dependency-invalidation.md`):
   `node "$PRISMA_ROOT/scripts/invalidate.js" guard memory/runs/$ARGUMENTS --phase=review`. Ele lê
   `state.json.artifact_validity.implement` (você não compara hash). `ALERTA (STALE)` =
   "Implement produzido contra Spec vN. Compliance avaliada pode não refletir Spec vM.";
   `ALERTA (UNKNOWN)` = implement legado sem versão. **Não bloqueia**: revise normalmente
   e cite o alerta nas `observations`; o `record` grava `implement_validity` e
   `compliance_valid: false`, que chegam ao Verify. Voltar ao Plan não é decisão sua —
   é da governança de SPEC_CHANGE (`scripts/lib/spec-change.js`).

### Dimensão 1 — SPEC COMPLIANCE

1. **Leia a spec na versão certa, direto da fonte.** Não use o texto de AC do
   handoff/plan/context — use:
   `node "$PRISMA_ROOT/scripts/lib/review-result.js" spec memory/runs/$ARGUMENTS --template`
   Ele recalcula o hash da spec e só imprime se bater com `state.json.spec_hash` (ou
   com SPEC_CHANGE aprovado; exit 3 = drift, pare como no passo 0). Saída: caminho e
   hash, **ACs ativos** (removidos aparecem marcados e não são avaliados),
   Restrições, Escopo/Fora de escopo/Arquivos Afetados (se a spec tiver),
   `## Decisões de Implementação`, as `technical_decisions` registradas (state.json e
   spec gate) e o esqueleto do JSON de entrada do passo 6.
   O `plan.md` diz COMO cada AC seria atendido (`## Cobertura dos ACs`) — use-o para
   saber onde olhar no diff, não como contrato. Se handoff/plan/context descreverem
   um AC diferente da spec, **vale a spec**, e o desvio é divergência (passo 3).
   **Matriz de cobertura** (`acceptance-evidence.json`): na primeira passada ela não
   existe — **não a exija nem a crie**. Se existir (loop Test/Verify → Implement →
   Review), os ACs `FAIL`/`BLOCKED`/`NOT_AUTOMATED` dela
   (`jq '.coverage | map_values(.status)'`) dizem onde olhar no diff; nunca
   substituem a leitura do diff e não entram no veredito.
2. **Avalie cada AC ativo contra o diff real**, um por um:
   - `PASS` — com **evidência** concreta: `arquivo:linha` do diff que implementa o
     comportamento descrito no AC (não "implementado no service").
   - `FAIL` — com **motivo**; todo AC FAIL exige uma divergência do passo 3 com o
     mesmo `ac` (`IMPLEMENTATION_BUG` ou `SPEC_CHANGE`).
   - `N/A` — só quando o AC não é atendível por este diff (ex.: AC de outro repo
     do ticket, AC puramente operacional), com motivo. Nunca use N/A para "não
     achei" — isso é FAIL.
   Além dos ACs, responda as 4 validações da spec (`checks` no JSON, PASS/FAIL/N/A
   com nota):
   - `restricoes` — nenhuma Restrição da spec quebrada;
   - `escopo` — arquivos/escopo funcional da spec respeitados (quando a spec traz
     Escopo/Fora de escopo/Arquivos Afetados; senão N/A);
   - `decisoes` — cada entrada desta task em `## Decisões de Implementação`
     corresponde a algo no diff e se sustenta (Motivo coerente com o código, não
     quebra Restrição nem regra inviolável de `memory/project.yaml`); entrada sem
     correspondência no diff também é FAIL;
   - `comportamento_nao_especificado` — nenhuma mudança de comportamento observável
     que a spec não pede (efeito colateral em tela/endpoint/regra fora dos ACs).
3. **Classifique toda divergência código × spec** (uma entrada em `divergences[]`
   por divergência; `alters_behavior: true` quando ela muda comportamento funcional):

   | Classificação | Quando | Efeito |
   |---|---|---|
   | `IMPLEMENTATION_BUG` | O código deveria seguir a spec e não seguiu | **Reprova** |
   | `DOCUMENTED_TECHNICAL_DECISION` | Decisão técnica consciente, **sem** alterar comportamento funcional | Não reprova — **se** registrada (abaixo) |
   | `SPEC_CLARIFICATION` | A spec era ambígua e o código só explicita um comportamento compatível com ela | Não reprova; segue para o Verify |
   | `SPEC_CHANGE` | Altera AC, regra de negócio ou restrição funcional | **Reprova** (vira `SPEC_CHANGE_REQUIRED`); exige aprovação explícita da mudança da spec |

   - `DOCUMENTED_TECHNICAL_DECISION` só vale com registro em
     `state.json.technical_decisions[]` —
     `{ "ac": "AC-01", "rationale": "...", "approved_at": "<ISO-8601>" }` — ou no
     `technical_decisions[]` do spec gate (`memory/runs/<ticket>-spec-gate.json`,
     aprovação explícita no spec gate). Sem registro, o script reclassifica como
     `UNREGISTERED_TECHNICAL_DECISION` e **reprova**. Nunca grave
     `technical_decisions` no Review para fazer a divergência passar.
   - Decisão marcada como técnica (ou como esclarecimento) que **na realidade altera
     comportamento funcional** → marque `alters_behavior: true`: o script reclassifica
     como `SPEC_CHANGE_REQUIRED` e reprova, mesmo com registro.
   - `SPEC_CHANGE` reprova sempre no Review, mesmo documentada em Decisões de
     Implementação — documentar não autoriza mudar o WHAT. O caminho é um humano
     mudar a spec e aprovar (`spec_change_approved` + `spec_change_hash`); depois
     disso o código bate com a spec nova e não há divergência.
   - Na dúvida entre `SPEC_CLARIFICATION` e `SPEC_CHANGE`: se alguém que leu só a
     spec poderia razoavelmente esperar outro comportamento observável, é
     `SPEC_CHANGE`.
   - **Confira a classificação de cada decisão do /implement** (lista "Decisões
     classificadas pelo /implement" do passo 1 — `state.json.technical_decisions[]`
     com `type`, gravadas por `scripts/lib/spec-change.js`). Uma entrada em
     `decision_reviews[]` por decisão, com o `index` dela, `alters_behavior`,
     `reduces_ac` (true/false, olhando o diff, não a justificativa) e `note`:
     - `TECHNICAL_DECISION` que na realidade altera comportamento funcional →
       `alters_behavior: true`;
     - `SPEC_CLARIFICATION` que reduz AC (ou muda o comportamento esperado) →
       `reduces_ac: true` (ou `alters_behavior: true`).
     O script reprova e reclassifica como `SPEC_CHANGE_REQUIRED` (vira achado no
     handoff). `SPEC_CLARIFICATION` confirmada segue para o Verify junto dos
     esclarecimentos. Faltar uma decisão em `decision_reviews[]` = entrada inválida.
   - Toda divergência que reprova leva `expected` (o que a spec pede), `found` (o que
     o diff faz), `action` (específica: o que mudar e onde — método, condição, valor;
     nunca "corrigir lógica"), `ac` quando houver e `file`/`line` quando
     identificáveis.
   - Spec legada sem IDs `AC-XX` ou task sem spec: `spec_compliance.acs` fica vazio
     (Spec Compliance `N/A`, salvo divergência que reprova) — o Engineering Review
     segue normal.

### Dimensão 2 — ENGINEERING REVIEW

4. Responda o **checklist fixo de revisão**, item a item, explicitamente
   (o mesmo de antes — nada saiu):

   1. Token/chave exposta em diff? (BITBUCKET_API_TOKEN, REDMINE_API_KEY)
   2. Arquivo fora do escopo da task foi alterado?
   3. Lint passa? (rodar antes e passar só o resultado)
   4. Testes unitários relacionados passam?
   5. Novo endpoint tem validação de input?
   6. Log de erro expõe dados sensíveis?
   7. Mudança é reversível ou precisa de migration/rollback?
   8. Endpoint bate com o contrato OpenAPI da task? (só se existir
      `memory/runs/$ARGUMENTS/openapi-contract.yaml`; senão **N/A**)

   Como responder cada um:
   - **1**: use a pré-checagem do bloco. Se `ENCONTRADO`, falha — cite só o
     arquivo e a linha, **nunca reproduza o valor** (nem em `context.md`,
     `handoff.md`, nota do Redmine ou saída).
   - **2**: escopo **técnico** — compare o `--stat` com os arquivos do `plan.md` e
     com escopo/fora de escopo do `handoff.md` (arquivo alterado sem motivo no plano
     nem em Decisões). Escopo **funcional** da spec é o check `escopo` da Spec
     Compliance (passo 2); o mesmo arquivo pode falhar nos dois, com um achado em
     cada dimensão.
   - **3**: use o resultado do bloco (não rode de novo).
   - **4**: localize testes existentes dos arquivos alterados e rode apenas o
     recorte pertinente à toolchain declarada pelo consumidor (TEST_COMMAND /
     TEST_SCOPED_COMMAND). Sem teste relacionado = N/A; testes novos são do Test.
     Falha de ambiente é inconclusiva com motivo, sem inventar resultado.
   - **5**: só se o diff cria/altera endpoint (`@Path`, `@GET/@POST/...`, rota
     nova); senão **N/A**.
   - **6**: olhe `LOG`/`logger`/`printStackTrace`/`console.*` nas linhas
     adicionadas — token, senha, CPF/CNPJ completo, payload inteiro de request.
   - **7**: mudança de schema/entidade/dados (a checklist de migração do
     orquestrador no `context.md`, se houver) precisa de migration e rollback
     descritos; senão, "reversível por revert".
   - **8**: o contrato é gerado pelo Plan quando a task cria/altera endpoint REST.
     Use a linha `Item 8 (contrato OpenAPI)` do bloco pré-montado — o orquestrador já
     rodou `scripts/lib/openapi-validator.js` contra os `.java` alterados. Sem a
     linha no bloco (despacho manual, ou "nenhum Resource alterado no diff"), rode
     você mesmo, uma vez, apontando o Resource/Controller do endpoint:
     `node "$PRISMA_ROOT/scripts/lib/openapi-validator.js" memory/runs/$ARGUMENTS/openapi-contract.yaml <Resource.java> [DTO.java] --md`.
     O validador localiza o método por `@Path` + verbo, o DTO/record do corpo
     (`x-java-dto`, parâmetro de corpo ou `X.class` no método) e os status
     (`Response.status(...)`, `Response.ok()`, `ResponseFactory.*`, exceções JAX-RS).
     - Cada `[FAIL]` (endpoint ausente, campo do contrato ausente no DTO, status
       retornado que o contrato não declara, 2xx declarado e nunca retornado) é
       falha do item 8 — **salvo** se coberto por entrada em "Decisões de
       Implementação" (check `decisoes`, passo 2): o contrato é gerado por agente e pode estar errado.
     - `[WARN]` (tipo divergente, campo extra no DTO, 400/422 declarado sem retorno
       explícito, status dinâmico) = observação; confira à mão só o que parecer
       real.
     - Nunca edite o contrato no Review.
   - **Subagente de domínio só quando o diff toca o domínio dele**: consulte
     `sed -n '/^agentes_por_dominio:/,/^[a-z_]*:$/p' memory/project.yaml`
     (ex.: entidade/migration/isolamento → `schema-guardian`; auth, tenant,
     webhook, API pública → `security-reviewer`). Passe a ele a lista exata dos
     arquivos do domínio e a pergunta do item correspondente, com a instrução de
     ler só `git diff HEAD -- <esses arquivos>` e só a seção
     `regras_invioláveis` do `project.yaml`. Nunca `general-purpose`/`Explore`,
     nunca o diff inteiro, no máximo um subagente por domínio.

   **Perfil e pertinência** (espelho de `docs/handoff-contract.md`, "Confirmação do
   perfil e pertinência"; fora dos 8 itens, sem `item` no JSON): registre sempre
   duas linhas em `observations[]`, que vão para o `review-result.md` —
   `Perfil: G0 — sem mudança de comportamento` (só em G0) ou
   `Perfil: G<n> — <sinal confirmado>` (G1–G3, nunca "sem mudança"), com o perfil
   do `plan.md` (`## Riscos técnicos`); e
   `Pertinência spec/RN/ADR: sim | não — <motivo>`. Se o sinal não se sustenta no
   diff, escreva `Perfil: sobe para G<n> — <motivo>` e não confirme; nunca rebaixe.


   Item que falha leva um achado em `engineering.findings[]` com `item`, `file`
   (+ `line` quando der), `expected`, `found` e `action` específica. Nunca reprove
   de forma genérica ("qualidade", "melhorar") — se não cabe num item do checklist
   nem numa divergência do passo 3, não é motivo de reprovação: vai em
   `observations`.

### Resultado

5. **Monte o JSON de entrada** a partir do esqueleto do passo 1 e grave em
   `memory/runs/$ARGUMENTS/review-input.json` (sobrescreva a cada rodada):
   `spec_compliance.acs[]` (todos os ACs ativos), `spec_compliance.checks`,
   `divergences[]`, `decision_reviews[]` (uma por decisão do /implement), `engineering.items[]` (os 8), `engineering.findings[]` e
   `observations[]`. Apague do esqueleto os exemplos que não se aplicam (ex.:
   `divergences: []` se não houve divergência). Item 1: **nunca reproduza o valor**
   do secret em nenhum campo — só arquivo e linha.
6. **Grave o resultado** — é o script quem decide os vereditos, não você:
   `node "$PRISMA_ROOT/scripts/lib/review-result.js" record memory/runs/$ARGUMENTS --input=memory/runs/$ARGUMENTS/review-input.json`
   - exit 2 = entrada inválida (AC ativo faltando, AC FAIL sem divergência, item FAIL
     sem achado, `action` genérica, DOCUMENTED_TECHNICAL_DECISION sem `ac`...): **nada
     foi gravado**; corrija o JSON conforme as mensagens e rode de novo.
   - exit 0 = PASS, exit 1 = FAIL — os dois **gravaram**:
     - `state.json.review_results` — `verdict`, `spec_compliance` (veredito + resultado
       por AC + checks), `engineering` (veredito + 8 itens), `divergences` (com a
       classificação final e o motivo de qualquer reclassificação), `findings`,
       `spec_clarifications`, `technical_decisions_applied`, `spec_hash` e
       `spec_version` avaliados (versão `null` + `ALERTA SPEC_CHANGE mid-run` = o hash
       avaliado não é o da versão vigente — registre no handoff, não silencie),
       `round`, `history[]` (uma linha por rodada) e **`failure_origin`**:
       `"spec_compliance"` | `"engineering"` | `"both"` | `null` (PASS). É a métrica
       que o memory-consolidator usa para saber de onde vêm os loops.
     - `state.json.review_verdict` (`aprovado` / `reprovado (<origem>)`), por
       compatibilidade.
     - `memory/runs/$ARGUMENTS/review-result.md` — Spec Compliance (`- AC-01 — PASS |
       Evidência: ...` / `- AC-03 — FAIL | Motivo: ...`), divergências, Engineering
       Review (os 8 itens), achados, esclarecimentos de spec.
     - em `handoff.md`, o bloco entre `<!-- review-findings:inicio -->` e
       `<!-- review-findings:fim -->` (substituído a cada rodada).
   - Se houver contrato OpenAPI, acrescente ao `review-result.md` a seção
     `## Contrato OpenAPI` com **todas** as linhas `[FAIL]`/`[WARN]` do validador (as
     cobertas por decisão documentada ficam como `[WARN]` com a entrada de Decisões
     citada).
7. Registre em `context.md` o resultado: as três linhas (`Spec Compliance: ...`,
   `Engineering Review: ...`, `Resultado geral: ...`), uma linha por AC e uma por
   item do checklist.
8. Reescreva `handoff.md` **preservando** o bloco `## Referência da Spec` (sem copiar
   texto de critério) **e o bloco `review-findings`** que o passo 6 gravou — não
   edite nem resuma o que está entre os marcadores. Se aprovado, o handoff é para o
   Test (incluindo os esclarecimentos de spec, que o Verify precisa ver). Se
   reprovado, os achados do bloco são o critério de aceite da correção: cada um já
   traz **Categoria** (IMPLEMENTATION_BUG | SPEC_CHANGE_REQUIRED |
   UNREGISTERED_TECHNICAL_DECISION | ENGINEERING · item N), **AC afetado**,
   **Arquivo e linha**, **Comportamento esperado** (da spec), **Comportamento
   encontrado** (no diff) e **Ação esperada** — é isso que a próxima sessão de
   Implement lê, sem precisar do histórico da conversa de review. Achado
   `SPEC_CHANGE_REQUIRED` deixe explícito no handoff que precisa de decisão humana
   sobre a spec (o Implement não resolve sozinho).

## Aresta condicional
O veredito é o `review_results.verdict` gravado no passo 6. Nos dois casos, atualize
`updated_at`, `current_agent="claude"`, acrescente `"review"` ao `history` e uma entrada em
`agent_log` no formato exato `{"agent": "claude", "nodes": ["review"], "at": "<ISO-8601 UTC>", "note": "<resumo curto>"}` (`agent` é obrigatório no schema; entrada sem ele faz o watcher marcar a task `state_corrupted` e parar o ciclo), com o veredito na `note`.
Transição sempre pela CLI (nunca editando o `state.json`): `node "$PRISMA_ROOT/scripts/state-writer.js"
transition memory/runs/<task-id> --from=review --to=<nó> [--retry]` — `--retry` incrementa
`retries.review` na mesma escrita, com CAS (`docs/concurrency-map.md`). Exit 3 = `STATE_CONFLICT`/`SESSION_CONFLICT` (o run mudou ou outra sessão assumiu — a CLI já re-tentou uma vez quando fazia sentido): pare sem gravar mais nada e reporte.
- **PASS** → `--to=test`, rode `/test $ARGUMENTS`.
- **FAIL** → `--to=implement --retry` (incrementa
  `retries.review`), registre o motivo da reprovação (com `failure_origin`) em
  `context.md`, rode `/implement $ARGUMENTS` de novo.

## Limite de loop
Se `retries.review >= 3` (ver `max_retries` em `.graph/graph.yaml`), pare e escale
pro humano em vez de tentar de novo silenciosamente — 3 reprovações seguidas do mesmo
par Implement↔Review é sinal de escopo errado no Plan, não de bug pequeno. Na
escalada, cite o `review_results.history` (origem de cada rodada): loop só de
`spec_compliance` costuma ser spec ambígua ou SPEC_CHANGE não resolvido; só de
`engineering`, problema técnico recorrente.
