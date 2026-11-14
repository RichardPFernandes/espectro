# SPEC: PRI-341, decomposição ligada só no piloto (Espectro)

> **Status:** v1, aguarda aceite do Richard. Nível **Médio** (PR-A) e **Alto** (PR-B, separado). Issue: [PRI-341](https://linear.app/prisma-app/issue/PRI-341). Código lido em `main` `a2e956b`. RC-1 a RC-6 e RRC-F31-001/002 seguem NOT APPLIED.

## Contexto

A decomposição do Implement (PRI-287/310/311) está pronta, mas **reservada**: `readRoutingConfig` recusa `"decomposition": "on"` com `DECOMPOSITION_RESERVED` (`scripts/lib/model-routing-policy.js:368`). Nenhuma Run decomposta rodou de verdade, então não há custo medido. O RC-1 está cumprido com escopo (U10-a provado nas CLIs 2.1.319 e 2.1.323; `SUBAGENT_MECHANISM_PROOF`). A policy aprovada `routing-pri205@p1-2026-11-06` não tem as seções `subagent_roles`, `manifest_limits`, `workspace_watch_globs` (Q9). O piloto decidido em 13/11 é o repo do Espectro (este repo, JS).

## Objetivo

3 a 5 Runs decompostas fecham de ponta a ponta no piloto, com custo por Attempt registrado e comparado a um baseline monomodelo, sem mudar nenhum outro consumidor. O Richard vê o comparativo.

## Escopo e divisão em PRs

**PR-A (Médio, atrás da reserva):**
1. Policy de piloto nova no repo do piloto (config do consumidor, não da plataforma): `subagent_roles.default` = `default_route`, `manifest_limits` `{ max_entries: 20000, max_bytes: 268435456 }`, `workspace_watch_globs` `[".env", ".env.*"]`. Id e versão em Q2.
2. Validação que confere `subagent_roles.default` == `default_route` (hoje **não** conferida: `validateDecompositionSections` só checa forma).
3. Comparador de custo: lê `cost_tracking.nodes.<nó>.attempts[]` e devolve custo por Attempt e por Run, decomposta × monomodelo. Ausente = `null`, nunca 0 (UNK-AR-006). Indicador, sem limiar (D7).

**PR-B (Alto, AUTORIZO próprio, só depois do A mergeado):** remove a reserva (`model-routing-policy.js:368` e o aviso em `readmine-watcher.js:1534`) e grava `.claude/model-routing.json` do piloto com `mode: ON`, `decomposition: "on"`, `policy_ref` da policy do PR-A. Exige bump do checkout vivo, que é operação protegida; readback depois do bump.

**Fora:** S5.3/`failure_class` (PRI-312), escalonamento (PRI-290), qualquer outro consumidor, abstração de issue tracker (hoje só Redmine). Sem S5.3: `failure_class = null`, rework na mesma resolução, sem proposta. O consumidor `app-back` não muda: sem a chave no config dele, segue OFF.

## Critérios de Aceite

- AC-1: 3 a 5 Runs decompostas fecham no piloto; cada uma tem Attempts com custo registrado e o comparativo foi mostrado ao Richard (a issue só fecha com o aceite dele).
- AC-2: `decomposition: "off"` devolve argv e estado iguais ao golden ON da S4 (`routing-on-golden.test.js`); `mode: OFF` devolve o golden OFF byte a byte (`routing-off-golden.test.js`, AC-01). Os dois já rodam e continuam verdes.
- AC-3: em versão de CLI fora de `['2.1.319','2.1.323']`, `subagent_roles[].enforcement` fica `UNENFORCED` (`model-routing-decomposed.test.js`, AC-27) e a Run não alega ENFORCED.
- AC-4: policy com `subagent_roles.default` diferente de `default_route` é inválida (teste novo).
- AC-5: o comparador devolve `null` para custo ausente e nunca soma 0 no lugar (teste novo).
- AC-6 (PR-B): sem a chave `decomposition` no config, `app-back` é admitido como hoje (teste de admissão).

## Comandos e estrutura

- Testes: receita da skill `prisma-tests` (`harness/run-tests.js`, `REPO_PATH` e `PRISMA_ROOT` absolutos). Foco: `scripts/lib/model-routing*.test.js`, `routing-*-golden.test.js`.
- Policy e config do piloto: `.claude/model-routing.json` e o arquivo apontado por `policy_ref.path`, ambos relativos à raiz do consumidor. Comparador em `scripts/lib/`, com teste ao lado.

## Boundaries

- **Sempre:** comportamento novo com flag desligada até o PR-B; PR em draft; "Refs PRI-341"; evidência na seção Evidência do PR.
- **Perguntar antes:** ligar a flag, bump do checkout vivo, qualquer tocar em `app-back`, id/versão da policy.
- **Nunca:** copiar dado, credencial ou histórico do `app-back`; misturar config do piloto com código de plataforma; rebind automático de Run existente; repetir efeito externo incerto.

## Decisões (Richard, 14/11/2026)

- **Q2 (aprovada):** id `routing-pri205`, versão `p2-pilot-2026-11-16`, sha256 gravado na publicação.
- **Q3 (aprovada):** baseline = 3 Runs monomodelo (`decomposition` off, mesma policy) em tickets de porte parecido no piloto. Com n pequeno o comparativo é indicador, não prova.
- **Q4 (aprovada):** model ids, `class_to_tier` e `effort_map` copiados da `p1-2026-11-06` sem alterar. Fonte lida: rascunho aprovado em `~/Workspace/prisma-evidence/2026-11-09-jev-app-back/drafts/model-routing-policy.json` (sha256 `02923a43…`), sem tocar no `app-back`.

## Pergunta aberta

- **Q1 (decidida em 14/11, resta config do consumidor):** por ora o único tracker é o Redmine, e o futuro é aceitar outros trackers (Richard). Efeito nesta fatia: o piloto usa o adapter Redmine que já existe (`REDMINE_URL`, `REDMINE_API_KEY`, `assigned_to_id=me`; `scripts/readmine-watcher.js:322`). **Não se cria camada de tracker aqui** (seria engine paralelo, AGENTS.md regra 4); vira issue própria quando houver o segundo tracker. Resta só config do consumidor, fora do código: qual projeto Redmine, ticket(s) e `REPO_PATH`/launcher do piloto. Bloqueia T6 em diante, não o PR-A. Sessão pessoal não consulta Redmine (conteúdo M&O é de sessão team).
