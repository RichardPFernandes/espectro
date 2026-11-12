# SDD: PRI-334, a tentativa roteada no cost_tracking viola o state.schema

> **Status:** v1.1, com os achados da G3 r1 aplicados (disposição no fim). Aguarda o aceite do
> Richard. Nível **Alto** (contrato de estado autoritativo; afeta o consumidor
> com roteamento ligado). Implementação e testes na mesma fatia, para a revisão G3. Nada no
> consumidor muda sem AUTORIZO específico (bump, retomada e religar o roteamento são atos
> separados).
>
> Issue: [PRI-334](https://linear.app/prisma-app/issue/PRI-334). Relacionada à PRI-233
> (S4, roteamento com flag), cujo T7 criou a forma roteada da tentativa. `roadmap-ref: UNKNOWN`.
> Código lido em `main` `5f180dd`.

## Contexto

O T7 da PRI-233 passou a gravar em `cost_tracking.nodes.<nó>.attempts[]`
(`scripts/lib/cost-tracking.js`, `attemptRecord`) a decisão do despacho roteado:

- `requested`: `{ model: chosen.model_id, effort: chosen.cli_effort | "UNAVAILABLE" }`;
- `selection_source`: a origem gravada na RoutingDecision;
- `routing_decision`: a RoutingDecision inteira.

O `costAttempt` de `.graph/schemas/state.schema.json` não acompanhou essa mudança e ainda aceita
só a forma sem roteamento (`UNAVAILABLE`, `DEFAULT_INHERITED`, `UNAVAILABLE`). No tick seguinte,
`validate-state` reprova o `state.json` e `handleCorruptedState` marca a run como
`state_corrupted`, escala e não redespacha. Essa reação está certa: o erro está no contrato.

**Observado no consumidor (11/11/2026):** com `mode: ON` desde 09/11, as duas primeiras runs
roteadas pararam em `state_corrupted` logo depois do plan, com os mesmos três erros. Como
contenção, o roteamento foi desligado com AUTORIZO (comentário na PRI-334). As duas runs
continuam presas ao snapshot ON fixado na admissão e não são reatribuídas.

**Por que os testes não pegaram:** o `routing-on-golden.test.js` compara argv, attempts DOM-06
e `{node, status, history}` do estado, mas não valida o `state.json` contra o schema.

## Objetivo

O `state.json` gravado depois de um despacho roteado passa no mesmo validador que o watcher usa
no tick seguinte. Uma regressão desse contrato quebra a suíte, não a operação.

## Escopo

**Inclui:**
- `costAttempt.requested`: `model` aceita `UNAVAILABLE` ou um id não vazio; `effort` aceita
  `UNAVAILABLE` ou o vocabulário do CLI (`low`, `medium`, `high`, `xhigh`, `max`, o mesmo de
  `CLI_EFFORTS` em `model-routing-policy.js`).
- `costAttempt.selection_source`: `DEFAULT_INHERITED` mais o vocabulário do roteamento,
  levantado no código: `FIXED_NODE`, `RULES`, `CONSERVATIVE_DEFAULT`, `PLAN_RAISED`,
  `LINEAGE_FLOOR`, `RISK_RECLASSIFIED` e `HUMAN_OVERRIDE` (`model-routing.js`,
  `would-route.js`, `decomposition-visit.js`).
- `costAttempt.routing_decision`: `UNAVAILABLE` ou um objeto com `node`, `chosen.model_id`
  (não vazio) e `selection_source` do vocabulário do roteamento, sem `DEFAULT_INHERITED`. Os
  demais campos da decisão são registro e não ficam presos pelo schema.
- No golden ON, cada `state.json` passa por `validateState` e o teste exige pelo menos uma
  tentativa roteada no `cost_tracking`, com `ajv` presente.
- No teste de unidade de `cost-tracking`, a forma roteada é aceita (todas as origens, com e sem
  esforço aplicado) e as formas inválidas são rejeitadas.

**Não inclui:**
- Mudar o que o `attemptRecord` grava. A forma gravada é a correta (PRI-233 T7).
- Mudar `handleCorruptedState` ou relaxar a validação.
- Retomar as runs paradas, fazer o bump do consumidor ou religar o roteamento. São operações
  protegidas, cada uma com AUTORIZO próprio (AC-03 e AC-04 da issue).
- `subtask` e `workspace` do `costAttempt` (sempre `UNAVAILABLE` no `attemptRecord` de hoje) e o
  caminho decomposto, que continua com a flag reservada.
- A cópia antiga do schema no consumidor (`app-back/.graph/schemas`), que o watcher não usa:
  `validate-state` lê `PRISMA_ROOT/.graph/schemas/state.schema.json`.

## Critérios de Aceite

- AC-01: um `state.json` com tentativa roteada, como o `attemptRecord` grava, passa no
  `validateState`, com qualquer origem do vocabulário e com ou sem esforço no argv. A forma sem
  roteamento continua passando.
- AC-02: o golden ON valida cada `state.json` pós-despacho contra o schema e exige pelo menos uma
  tentativa roteada. Com o schema anterior, o teste falha com os três erros observados.
- AC-03: o schema rejeita `selection_source` fora do vocabulário, modelo pedido vazio, esforço
  fora do CLI, decisão sem `chosen`, decisão com `DEFAULT_INHERITED` e decisão que não é objeto.
- AC-04: o golden ON (argv, attempts, estado) fica idêntico ao gravado, sem regenerar.
- AC-05 (G3, A-01): numa leitura local dos `state.json` das runs paradas do consumidor, com
  `status` = `state_error.previous_status` e sem `state_error`, o resultado passa no
  `validateState` do schema novo, sem alterar `cost_tracking`. A evidência registra só o
  resultado e as contagens, sem nenhum dado do consumidor.
- AC-06 (G3, A-02/A-03/A-04): o vocabulário roteado fica numa só definição
  (`definitions.routingSelectionSource`), igual a `SELECTION_SOURCES` de `model-routing.js`
  (teste). O schema exige `snapshot_sha256` (hex de 64) na decisão e recusa combinações que o
  writer não produz: decisão objeto com origem `DEFAULT_INHERITED` ou sem modelo pedido;
  decisão `UNAVAILABLE` com origem roteada ou modelo pedido.
- AC-07 (G3, NIT 3): cada ramo de `resolveRoute` que chega ao `cost_tracking` (`FIXED_NODE`,
  `RULES`, `CONSERVATIVE_DEFAULT`, `PLAN_RAISED`, `HUMAN_OVERRIDE`), com e sem esforço
  aplicado, gera uma tentativa que valida no schema.

## Revisão G3 (r1) e disposição

Revisor Opus (`claude-opus-5-5`) e Arquiteto (`claude-opus-5-5`), cada um em contexto limpo:
independência por contexto, com o mesmo fornecedor. Os dois deram **APPROVED_WITH_CHANGES**,
sem BLOCKER. Diff revisado: sha256 `99a2918721593172…`.

| Achado | Severidade | Disposição |
| -- | -- | -- |
| A-01 pré-condição da retomada sem AC/evidência | MAJOR | Aplicado: AC-05, evidência no handoff |
| A-02 vocabulário duplicado em dois enums | MINOR | Aplicado: `definitions.routingSelectionSource` + `SELECTION_SOURCES` + teste de igualdade |
| A-03 combinações incoerentes aceitas | MINOR | Aplicado: `allOf` com `if/then` nos dois ramos; 4 rejeições novas no teste |
| A-04 `snapshot_sha256` não exigido | MINOR | Aplicado: obrigatório, `^[a-f0-9]{64}$`; `node` com `minLength: 1` |
| A-05 caminho decomposto sem validação de schema | MINOR | Follow-up: [PRI-335](https://linear.app/prisma-app/issue/PRI-335), pré-condição do gate de ligar a decomposição |
| A-06 runbook, cenário 7 | NIT | Aplicado: "o schema pode estar atrás do writer" |
| A-07 handoff | NIT | Aplicado: `tasks/pri-334/handoff.yaml`, `nivel_processo: alto` |
| Opus 1: `effort_map` do override sem checagem contra `CLI_EFFORTS` | MINOR | Follow-up: [PRI-336](https://linear.app/prisma-app/issue/PRI-336), antes de o mecanismo de esforço virar `VERIFIED` (hoje inalcançável) |
| Opus 2: contador agregado no golden | NIT | Aplicado: tentativa roteada exigida por cenário |
| Opus 3: só decisão sintética para HUMAN_OVERRIDE e outros | NIT | Aplicado: AC-07, `resolveRoute` real em `model-routing.test.js` |
| Opus 4: mensagem do `require.resolve('ajv')` | NIT | Aplicado |

### G3 r2 (delta)

Revisor Opus e Arquiteto, os dois **APPROVED_WITH_CHANGES**, sem BLOCKER; o Arquiteto aprovou
código e schema sem ressalva. Diff revisado: sha256 `705234ca50d611fd…`.

| Achado | Severidade | Disposição |
| -- | -- | -- |
| R2-1 igualdade schema × constante não pega literal novo no código | MINOR | Aplicado: o teste extrai os literais de `selection_source` dos três módulos e exige igualdade nos dois sentidos. A mutação `RULES` → `RULES_V2` em `would-route.js` derruba o teste |
| R2-2 / A-09 handoff citado e ausente | MINOR | Aplicado: `tasks/pri-334/handoff.yaml` |
| A-08 runbook sem bump/readback e AUTORIZO; passo 3 contraditório | MINOR | Aplicado: ordem conter → corrigir → bump com readback → retomada pulando o passo 3 → religar a flag, cada ato com AUTORIZO |
| A-10 ramo roteado sem `required` | NIT | Aplicado: `required: [selection_source, requested]` no `then` |
| A-11 IDs dos follow-ups | NIT | Aplicado: PRI-335 e PRI-336 |
| R2-3 golden sem LINEAGE_FLOOR/RISK_RECLASSIFIED | NIT | Já no follow-up PRI-335 |

Incidente durante a revisão: um `git stash pop` encadeado do revisor restaurou na worktree 92
arquivos não rastreados de um stash antigo. A diff da fatia não foi afetada (sha conferido). Os
92 caminhos foram removidos um a um, conferidos contra a lista do stash, e o `stash@{0}`
continua intacto.

## Restrições

- Não reescrever histórico: as tentativas já gravadas nas runs paradas ficam como estão e devem
  validar com o schema novo (conferido em leitura local, sem copiar dados do consumidor para o
  repositório).
- Nenhum dado do consumidor em fixture, teste ou Linear (AGENTS.md 6).
- Flag e polling não são tocados por esta fatia.
