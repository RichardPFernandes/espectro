# Evidência por AC: PRI-233 (PRI-205 S4)

> Revisão: `ea9e42d18d65220580173ff5573c3a9d1f1c971f` (branch `pri-233-s4-routing`,
> base `829254d`), worktree limpo. Execução em 2026-11-06T14:27Z pela receita oficial
> (`docs/runbook.md`: `env -i`, HOME/TMPDIR sintéticos, `loopback-only`).
> Evidência persistida: `~/Workspace/prisma-evidence/2026-11-06-pri-233/`
> (`summary.txt`, TAPs `node22.23.2-*` e `node24.22.1-*`).
>
> Este arquivo **não** declara Done nem aceite: a regra por AC de
> `docs/handoff-contract.md` exige Verify PASS da versão vigente ou evidência
> conferida em revisão independente. O Verify e a revisão independente dos commits
> posteriores a `4311575` ainda não rodaram.
>
> **Atualização (T8):** depois desta revisão, a T8 entrou (override humano). A linha do
> AC-09 cita os testes novos; a tabela de execução abaixo continua sendo a de `ea9e42d`.
> Execução da T8 no Node 22: scripts 1257/0, dashboard 301/0, `check:js`, `lint:src` e
> `arch:check` limpos. A evidência persistida será refeita na revisão final.

## Execução

| Comando (receita oficial) | Node | Resultado | Evidência |
| -- | -- | -- | -- |
| `npm --prefix scripts test` | 22.23.2 | 1241 pass / 0 fail / 6 skip | `node22.23.2-scripts.tap` |
| `npm --prefix dashboard test` | 22.23.2 | 299 pass / 0 fail | `node22.23.2-dashboard.tap` |
| `npm --prefix scripts test` | 24.22.1 | 1241 pass / 0 fail / 6 skip | `node24.22.1-scripts.tap` |
| `npm --prefix dashboard test` | 24.22.1 | 299 pass / 0 fail | `node24.22.1-dashboard.tap` |
| `scripts: check:js`, `lint:src`, `arch:check` | 22.23.2 | exit 0 (sem violação nova) | `node22.23.2-scripts-*.txt` |
| `dashboard: check:js` | 22.23.2 | exit 0 | `node22.23.2-dashboard-check-js.txt` |

Os 6 testes pulados já eram pulados na base (rodada da T1). No Node 20.20.2 local, 3
testes de `architecture-boundaries` falham porque o dependency-cruiser exige Node ≥ 22;
isso é do ambiente e não muda o resultado. O CI usa Node 22 e 24.

## Estado por AC

Legenda: **AUTOMATIZADO** = teste automatizado PASS nesta revisão, no nível pedido
pelo AC. **SÓ UNIDADE** = PASS em teste de unidade, sem prova no watcher (motivo
na linha). **PENDENTE** = sem implementação. Nenhum AC tem exceção humana registrada.

| AC | Estado | Testes (arquivo › título) | Observação |
| -- | -- | -- | -- |
| AC-01 | AUTOMATIZADO | `routing-off-golden.test.js` › "AC-01: sem routing e com mode OFF, o despacho é igual ao golden do AS-IS"; `routing-admission-watcher.test.js` › "T5: Run admitida OFF…", "MAJOR-1: admissão OFF depois de um ciclo ON…" | O golden tem 25 cenários (ticket novo e 6 nós × 4 causas), gerado na base antes da S4. A mutação `--model` no argv foi detectada (teste de injeção feito na T1, não repetido nesta revisão). O golden compara argv/env, não arquivos gravados. |
| AC-02 | SÓ UNIDADE | `model-routing.test.js` › "caminho feliz (Implement, C1)…", "routedArgs acrescenta --model…"; `cost-tracking.test.js` › "PRI-233 T7: Attempt roteado grava RoutingDecision…" | O despacho roteado não acontece em produção (SP-1: mecanismo de esforço UNAVAILABLE), e não existe porta dos fundos para forçá-lo no watcher (AD-5). |
| AC-03 | AUTOMATIZADO | `model-routing.test.js` › "A2: nós fora do Implement vão no default_route…"; `routing-admission-watcher.test.js` › "T7 / AC-03: ticket novo ON → fetch_ticket+plan no default_route…" | Prova a decisão (`default_route`, `FIXED_NODE`) e que nada é despachado sem `--model` com mode ON (todo despacho ON termina em NOT_STARTED hoje). O argv com `--model` só tem prova em unidade (ver AC-02). |
| AC-04 | AUTOMATIZADO | `routing-admission-watcher.test.js` › "T5/T6: admissão ON inválida recusa…", "T6: um aviso por projeto em 3 ticks…"; `routing-config.test.js` (29 casos); `config-validator.test.js` › "routing-config: …" | Sem Run, sem worktree, sem marcador; 1 aviso no Redmine em 3 ticks mais um 2º ticket; projeto OFF segue; Run em andamento mantém o snapshot. |
| AC-05 | AUTOMATIZADO | `routing-admission-watcher.test.js` › "T7 / AC-05: snapshot adulterado…", "MAJOR-1 (a): Attempt de admissão apagado…", "MAJOR-1 (d): ligação apagada…"; `model-routing.test.js` › "passo 1: …" (6 casos); `routing-run.test.js` | Prova que não relê a config: a config corrente OFF não muda a recusa. |
| AC-06 | SÓ UNIDADE | `model-routing.test.js` › "passo 2: provider …" (4 estados), "passo 5: nenhum candidato…", "passo 3: override inelegível…" (2) | No watcher o provider é `ACTIVE` fixo, porque não existe dono do estado do provider (UNK-AR-005). |
| AC-07 | AUTOMATIZADO | `routing-admission-watcher.test.js` › "T7 / AC-07: Run ON em andamento em produção…", "MINOR-1 + retry: …"; `model-routing.test.js` › "mecanismo de esforço UNAVAILABLE…" | 1 Attempt NOT_STARTED, Run `blocked`, 1 aviso em 3 ticks, agente nunca roda, sem cair para `--model` sozinho. |
| AC-08 | SÓ UNIDADE | `claude-account.test.js` › "PRI-233 SP-2…" (6) e "PRI-233 MAJOR-2…" (5); `model-routing.test.js` › "plugin … → CONFIG_UNVERIFIABLE/PLUGIN_NOT_PROVEN_OFF" (3) | No watcher, a prova do plugin só roda com o esforço verificado (SP-1, AD-5). A precedência do `--settings` sobre os settings do projeto não foi conferida contra o CLI real (premissa registrada). |
| AC-09 | AUTOMATIZADO (T8, depois desta revisão) | `routing-admission-watcher.test.js` › "T8 / AC-09: override vigente entra na decisão…", "T8 / D-4: override gravada no meio da visita…"; `authorization.test.js` › "PRI-233 T8: …" (9); `authorization-api.test.js` › "PRI-233 T8: …" (2); `routing-run.test.js` › "nodeVisitStart: …" (3); `model-routing.test.js` › "passo 3: …" | Writer: `authorization.recordRoutingOverride` (P-2 aprovada), via `POST /api/runs/:taskId/routing-override` com aprovador e CAS, sem pausar a Run. Escopo subtarefa só casa com `subtask_key` (S5). Ainda não há formulário no Dashboard, só a API. |
| AC-10 | AUTOMATIZADO | `dom06-attempt.test.js` › "AC-10: causa escalation é recusada…", "escalation_proposal: …", "causa desconhecida continua virando dispatch…" | |
| AC-11 | AUTOMATIZADO (parcial) | `model-routing.test.js` › "A4: jev sem Authority Ref…", "A4: jev com Authority Ref continua off…"; suíte sob `loopback-only` | Nenhuma chamada de rede ao Jev; o efetivo é off com motivo. A reavaliação real da Authority Ref na admissão não existe: o watcher passa `authorityRef: null` (MINOR-8 da revisão, que depende de Authority Ref durável, DP-7). |
| AC-12 | AUTOMATIZADO | `model-routing.test.js` › "determinismo: 100 resoluções da mesma entrada são idênticas (AC-12)" | |
| AC-13 | AUTOMATIZADO | suítes acima | Nenhum teste removido ou pulado. Testes já existentes que mudaram: `config-validator.test.js` (CLI espera 7 regras em vez de 6, pela regra nova) e 5 arquivos com correções de corrida (`churn-detector`, `cost-tracking`, `node-events`, `node-lease`, `transcript-writer`): só espera ou retry, nenhuma asserção alterada. |

## O que ainda falta para o Done (G3, Implementação)

- **Verify** da versão vigente (`/verify`, ou o equivalente do ciclo interativo).
- **Revisão independente** (contexto limpo, Claude; o Codex não é mais usado, e o contrato foi atualizado na `main` em #93). A revisão rodou em `829254d..4311575`; os commits posteriores (`488cea8`, `afdd121`, `ea9e42d`, as correções do Bugbot e a T8) ainda não foram revisados.
- **Evidência persistida** refeita na revisão final.
- PR Draft: aberto (#97).
- Aceite dos ACs pelo owner e confirmação do Done pelo Richard; o merge é exclusivo do Richard.
