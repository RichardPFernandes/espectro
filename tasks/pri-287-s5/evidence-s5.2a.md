# Evidência — PRI-311 S5.2a (PRI-287): contrato + manifesto ligados

Adendo: `tasks/pri-287-s5/SPEC-s5.2.md` v2.1 (aprovado pelo Richard em 2026-11-09, Q8–Q14), sobre
`tasks/pri-287-s5/SPEC.md` v2.1. Escopo da S5.2a: passos 0a a 6 (tarefa 0, extensão da S1, H0 a H6,
seções da policy); AC-36 a AC-45 e AC-35. Base: `main` `cc72b55`.

A flag `decomposition: "on"` segue **reservada** (`DECOMPOSITION_RESERVED`): nenhum caminho de
produção cria Attempt com `role` nesta fatia (`prepareRoleDispatch` só tem chamador nos testes; o
ponto de chamada no despacho entra na S5.2b). RC-1 a RC-6 e RRC-F31-001/002 seguem **NOT APPLIED**.
WATCHER_QA_DIAGNOSTICO e o polling de PR não foram tocados.

## Verificação por AC

| AC | Onde | Resultado |
| -- | -- | -- |
| AC-36 (H1) | `decomposition-runtime.test.js`: dois caminhos (wrapper `node-lease.js release` e `releaseLease`/`closeRoleAttempt` exportados do watcher), lease sem chave nem escopo, `SCOPE_TAMPERED`/`BASELINE_MISSING`, `plan_version` do snapshot do release (O-02), ordem pós-`drained` | PASS |
| AC-37 (H2) | isenção só sem mutação (indisponibilidade e session_limit), mutação → `blocked`, pai isento fora do teto, `HUMAN_RESUME` reinicia o teto, log a partir do offset, wrapper com cauda do log | PASS |
| AC-38 (H3) | seções ausentes → padrões; forma inválida → `POLICY_INVALID`; `model_id` irreal recusado; papel inexistente não é erro; projeto OFF não lê | PASS |
| AC-39 (H4) | órfão `agent_dead` sem/com mutação, `agent_dead` com post UNKNOWN, `timeout` → `blocked`; `recoverOrphans` chama `onOrphan`; sem Attempt com papel nada muda | PASS |
| AC-40 (H5) | `_archive` mantém a chave; sem Run em nenhuma raiz → apaga; idempotente; filtro; chave apagada sob Run viva → `KEY_MISSING` (a saída nunca recria a chave); Run revivida → `blocked` até `HUMAN_UNBLOCK` (Q14 a) | PASS |
| AC-41 (tarefa 0) | probe `scripts/probes/u10-subagent-model.js` + avaliação pura (4/4); execução real em 2026-11-09, evidência agregada em `tasks/pri-287-s5/u10-probe-evidence.json` | **PASS: prova obtida para U10-a (`--agents`)**; U10-b (env) sem prova. Ver "Tarefa 0" |
| AC-42 (H6) | `pendingBlock`: só `in_progress`, uma vez por Attempt, nunca sobre `session_limit`/status do comando, ato humano posterior ao aceite prevalece (C-O-01); writer `applyDecompositionBlock` conferido no fonte | PASS (writer por inspeção do fonte: `notifyBlocked` faz chamada ao Redmine, fora do harness loopback-only) |
| AC-43 (H6) | cadeia: encadeado, `CHANGED_BETWEEN_ATTEMPTS`, `RUN_START`, `HUMAN_RESUME`, `HUMAN_UNBLOCK`, `SCOPE_CHANGED` com e sem mutação no escopo antigo, anterior sem post → `PREVIOUS_POST_UNKNOWN` | PASS no nível da lib (ver desvios) |
| AC-44 (H0) | baseline com resumo e `scope_hmac`, sem caminho; arquivo local com o escopo, fora do worktree | PASS no nível da lib (ver desvios) |
| AC-45 (passo 0b) | `subagentRoleAttribution` (meta.json + tool_use; CONFLICTED; UNKNOWN); golden de `sumClaudeUsage` | PASS. O golden `scripts/fixtures/cost-usage-golden-pri311.json` foi gerado com o `cost-tracking.js` de `cc72b55` (árvore extraída por `git archive cc72b55`), antes de qualquer mudança desta fatia |
| AC-35 | ver "Suítes" | ver abaixo |

## Tarefa 0 (U10), execução real

Perfil isolado `~/u10-probe/profile` (login feito pelo Richard; nenhuma credencial lida, copiada ou
registrada), plugin `jev-model-router` desligado provado (`NOT_LOADED`) em todas as execuções, sem MCP,
repositório git sintético, CLI `2.1.319 (Claude Code)`. Modelos: principal opus, frontmatter haiku,
declarado sonnet. Teto de 6 chamadas atingido exatamente.

| # | Candidato | Execução | Resultado | Observado (u10-role-a / u10-role-b) |
| -- | -- | -- | -- | -- |
| 1 | control | 1 | UNCERTAIN (exit 1) | — / — |
| 2 | control | 1 (repetição autorizada: «Sim, repetir e seguir», Richard, 2026-11-09) | CONTROL_DETECTS_FRONTMATTER | haiku / haiku |
| 3 | agents (U10-a, `--agents` no argv) | 1 | **PROOF_OBTAINED** | sonnet / sonnet |
| 4 | agents | 2 | **PROOF_OBTAINED** | sonnet / sonnet |
| 5 | env (U10-b, `CLAUDE_CODE_SUBAGENT_MODEL`) | 1 | PROOF_NOT_OBTAINED | haiku / haiku |
| 6 | env | 2 | PROOF_NOT_OBTAINED | haiku / haiku |

- A execução 1 falhou por defeito do probe (ambiente sem `USER`/`LOGNAME`: o CLI não achou o login no
  Keychain e respondeu sinteticamente "Not logged in", sem chegar ao modelo). Corrigido; a repetição só
  rodou com o «sim» do Richard, registrada no ledger e na evidência.
- Papel atribuído só com `META+TOOL_USE` (meta.json casado com o `subagent_type` do tool_use).
- **Conclusão:** `--agents` no despacho fixa o modelo do subagente por papel com precedência sobre o
  frontmatter do projeto (a hipótese O-10 de precedência desfavorável não se confirmou nesta versão
  do CLI). A variável de ambiente não fixa (o frontmatter prevalece).
- **Limites:** só modelo; esforço do subagente não foi verificado (U1 segue aberto). Só os dois
  papéis sintéticos de projeto; subagentes embutidos da CLI não foram testados. Resultado da versão
  2.1.319 do CLI.
- **Gate do RC-1:** a evidência registra **prova obtida (U10-a)**. Cumprir ou dispensar o gate é ato
  do Richard (Portas, item 1); esta fatia não o declara cumprido. O mecanismo entra no `routedArgs`
  só na S5.2b (Attempts com `role` e `subagent_roles` na policy).

## Suítes

Receita oficial (`harness/run-tests.js` via `npm test`, `env -i`, HOME/TMPDIR sintéticos,
`loopback-only.cjs`), sobre o código final desta fatia (worktree com o diff, HEAD `4e06906` + mudanças),
2026-11-09:

| Pacote | Node 22.23.2 | Node 24.22.1 |
| -- | -- | -- |
| `scripts/` | 1876 testes: 1870 pass, 0 fail, 6 skipped | 1876 testes: 1870 pass, 0 fail, 6 skipped |
| `dashboard/` | 394/394 pass | 394/394 pass |

Uma rodada anterior (antes das correções da G3) teve 1 falha só no Node 24, em
`watcher-lock.test.js:175` ("trava velha: o laço retoma e sobe", ENOENT no log do watcher filho, em
TMPDIR sintético). Não se repetiu na rodada final, nas duas versões; tratada como intermitente de
tempo, sem relação demonstrada com o diff (UNKNOWN em CI Linux, não executado aqui).

Também executados em Node 22: `npm run check:js`, `npm run lint:src`, `npm run arch:check` (exit 0 nos três).
O teste do probe (`scripts/probes/u10-subagent-model.test.js`, 4/4) fica fora do harness por estar
junto do probe, que faz chamadas reais; rodado à parte com `node --test`.

## Revisão G3 do código (Opus + Arquiteto, contexto limpo, só leitura)

| Rodada | Opus | Arquiteto |
| -- | -- | -- |
| r1 | APPROVED_WITH_CHANGES (C-O-01 MAJOR; C-O-02…09 MINOR/NIT) | APPROVED_WITH_CHANGES (C-A-01 MAJOR; C-A-02…10 MINOR/NIT) |

Disposição:

| Achado | Disposição |
| -- | -- |
| C-O-01 / C-A-01 (MAJOR) | `pendingBlock` ignora o aceite quando há ato humano posterior (retomada, aprovação, desbloqueio); teste no AC-42 |
| C-O-02 | `--follow` sem código → falha (`AGENT_FAILURE`, `exit_code: null`); release falho → `CLAIM_UNKNOWN`; DRY-RUN fecha o Attempt com papel; teste |
| C-O-03 / C-A-06 | probe exige `META+TOOL_USE`; `META` sozinho não é prova; teste |
| C-O-04 / C-A-04 | desvio declarado abaixo |
| C-O-05 | teste do `--follow` chama `releaseLease`/`closeRoleAttempt` exportados do watcher |
| C-O-06 / C-A-02 | declarado abaixo; `storeBaseline` protegido (falha → `BASELINE_MISSING` na saída) |
| C-O-07 | task do órfão = nome do diretório da Run (mesma origem do lease e da varredura) |
| C-O-08 / C-A-03 | desvio declarado abaixo |
| C-O-09 / C-A-05 | desvio declarado abaixo |
| C-A-07 | teto e recusa de repetição do probe também contam os registros do `--out` (fora do perfil) |
| C-A-08 | pendência declarada abaixo |
| C-A-09 | comentários corrigidos; varredura reusa `runsRootsForStartup` |
| C-A-10 | proveniência do golden registrada no AC-45 |

## Desvios declarados em relação ao adendo

- **H0/H6 sem ponto de chamada no despacho (C-A-02, C-O-06):** `prepareRoleDispatch` (baseline + cadeia +
  Attempt) e `decompositionSections` existem e são testados, mas o despacho do watcher só os chama
  na S5.2b (passos 7 e 8), quando o ramo `implement` decomposto existir. AC-43 e AC-44 estão provados
  **no nível da lib**, não "ligados no watcher". `attachDom06Lease` recebe a task do nome do diretório
  da Run até a S5.2b passar o valor.
- **Campos do lease (C-A-03, C-O-08):** além de `dom06ManifestsDir` e `task`, o lease de Attempt com
  papel leva `dom06Role`, `logPath` e `logOffset` (este último previsto no H2). Nenhum carrega chave
  nem escopo (teste do AC-36).
- **Espera do filtro no modo destacado (C-A-04, C-O-04):** o wrapper `sh` não mudou. No lugar da
  espera do EOF do `sanitize-log` (impossível sem reestruturar o pipe, porque o próprio release
  escreve nele), `readLogFrom` espera o tamanho do log ficar estável (300 ms, teto 3 s). Best-effort;
  causa indeterminada = `AGENT_FAILURE` (conta no teto). As assinaturas de `session_limit` também
  são aplicadas ao stdout da cauda: risco contido pela isenção só sem mutação. Resíduo medido em m2.
- **Teto reiniciado também por `HUMAN_UNBLOCK` (C-A-05, C-O-09):** o adendo (R2-O-03) cita só
  `HUMAN_RESUME`; o código trata os dois atos humanos igual (ambos são continuação autorizada e
  registrada). Se preferir só `HUMAN_RESUME`, é uma linha (`HUMAN_ANCHORS`).
- **Retomadas humanas reconhecidas (H6):** `resumed_at` (dashboard `resume_session`) e os eventos
  `spec_change_approved`, `authorization_approved`, `authorization_manual`. O `by` é a origem do
  registro (`dashboard:resume-session`, `human:<evento>`), porque esses registros não guardam a
  identidade do humano no `state.json`.

## Pendências (fora desta fatia)

- **Gate do RC-1:** prova do U10-a obtida; a decisão de cumprir/dispensar o gate é do Richard. Esforço
  do subagente e subagentes embutidos seguem sem verificação.
- **C-A-08:** conferir que `subagent_roles.default` é igual ao `default_route` fica para a validação
  da policy de piloto ou para o PR de liberação da flag (A-04 iii); a validação de sintaxe da H3 não
  compara valores entre seções.
- **S5.2b:** ponto de chamada de `prepareRoleDispatch` no despacho; gates com manifesto (H7);
  `subagent_roles[]` na RoutingDecision a partir de `subagentRoleAttribution` (B8).

## Verify (nó aplicado manualmente)

- **Passos 0, 0b e 1 (scripts sobre `memory/runs/<task>`): N/A.** Trabalho interativo na plataforma,
  sem Run despachada da PRI-311 (mesma situação da S5.1). Não há matriz `acceptance-evidence.json`;
  a conformidade foi conferida à mão: cada AC da S5.2a (AC-35 a AC-45) tem linha na tabela acima com
  teste nomeado, todos rodados de novo na suíte final. AC-41 segue **PENDENTE** (não é PASS).
- **Passo 2:** os testes exercitam o texto dos ACs do adendo (não uma reinterpretação); onde o AC diz
  "no despacho" (AC-43, AC-44) a prova é no nível da lib, declarada nos desvios.
- **Passo 3 (escopo):** todos os arquivos do diff estão no plano do adendo (passos 0a a 6) ou são
  registro de dono/concorrência e schema. `config-validator.js`, listado no passo 1, não precisou
  mudar: a validação nova flui por `readRoutingConfig` → `validateRoutedPolicy`, já usada pela regra
  `routing-config`. Nada da S5.2b (despacho de subtarefa, comandos, B2/B5/B6) entrou.
- **Passo 4 (risco do PR): high.** Motivo: muda os dois caminhos de saída do agente, o release do
  lease e o recovery de órfão (`scripts/readmine-watcher.js`, `scripts/lib/node-lease.js`) e cria um
  dono de exclusão (`scripts/lib/decomposition-runtime.js`, `sweepKeys`). PR em draft.
