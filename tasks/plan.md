# Plano de implementação: PRI-233 (PRI-205 S4), roteamento com flag

> Deriva do [SPEC.md](../SPEC.md), aprovado em 2026-11-06. Este é o **COMO**; em
> divergência, o SPEC vence. Status: **APROVADO pelo Richard em 2026-11-06, com as
> recomendações de P-1 a P-4.** P-1: a SP-1 continua valendo e o achado do
> `--effort` vai para o U1 da PRI-205. P-2: opção (a), que ainda depende da
> confirmação do Arquiteto antes da T8. P-3: `.claude/model-routing.json`. P-4:
> `routing_snapshot` no `state.json`. Ainda não houve implementação. RC-1 a RC-6 e
> RRC-F31-001/002 continuam NOT APPLIED.
> Tarefas detalhadas em [todo.md](todo.md).

## Visão geral

O roteamento entra em três camadas, de baixo para cima:

1. **Funções puras:** validação de `routing`/policy, resolução do §4.7 e montagem
   do argv. Testáveis sem watcher.
2. **Owners existentes estendidos:** o DOM06 ganha o resultado `NOT_STARTED` e a
   reserva de `escalation`; o check de config ganha uma regra para `routing`; o
   registro do Attempt (`cost-tracking`) passa a ter a RoutingDecision.
3. **Ligação no watcher:** admissão da Run (ramo de ticket novo, antes do
   `fetch_ticket`) e despacho por nó.

Com `mode` ausente ou `OFF`, nenhuma camada nova executa nada que mude o argv. Isso
é travado antes de qualquer mudança por um golden do AS-IS (T1).

## Fatos do código que moldam o plano

| Fato (verificado em 2026-11-06) | Consequência |
| -- | -- |
| A Run nasce no ramo de ticket novo do watcher: `writeSpecGate` (`fetch_dispatch`) → `dom06.prepareDispatch` com `node: 'fetch_ticket'` em `memory/runs/_dom06`. O task-id é gerado pelo agente no `/fetch-ticket`. | "Não criar Run" significa recusar **antes** do `writeSpecGate`/`prepareDispatch`. O snapshot fica ligado ao Attempt de admissão do `fetch_ticket` e a task se liga a ele depois (T5). |
| `fetch_ticket` e `plan` vão juntos num único `claude -p`. | Com `mode = ON`, o segmento sai inteiro no `default_route` (D6: Plan fixo). |
| `blankAttempt` troca **silenciosamente** causa desconhecida por `'dispatch'`. | Hoje `escalation` já "passaria" como dispatch. A T4 recusa explicitamente, em vez de converter. |
| O DOM06 só conhece `UNKNOWN`/`DENIED`/`STARTED`. | `NOT_STARTED` + `CONFIG_UNVERIFIABLE`/`PROVIDER_NOT_ELIGIBLE` é extensão do owner (F13 já define o desfecho). |
| Admissão negada hoje vira `skip` e é tentada de novo a cada tick. | `NOT_STARTED` roteado não pode criar um Attempt por tick: o primeiro grava e bloqueia a Run pelo caminho humano existente, com um aviso só (T7). |
| `notifyPretaskBlocked`: Redmine + local, uma vez por assinatura (marcador). | Esse é o "canal existente" da SP-4; o bloqueio de admissão reusa o mesmo padrão de marcador. |
| `dom06-dispatch-env.test.js` roda o watcher real com um `claude` stub no PATH que captura o argv/env. | É a base do golden do AS-IS (T1) e dos testes de admissão (T6). |
| `cost-tracking.attemptRecord` já tem `requested`, `selection_source`, `routing_decision` e `effort_router_plugin`. | A RoutingDecision preenche campos que já existem; não precisa de registro novo. |
| `claude` 2.1.319 tem `--effort <low\|medium\|high\|xhigh\|max>`, `--settings`, `--setting-sources` e `--disable-slash-commands`. | Ver P-1: a parte "como pedir" do U1 parece resolvida pelo CLI. A SP-1 continua valendo até o Richard decidir. |
| `--settings` **acrescenta** settings. Não há evidência de que neutralize a árvore `skills/jev-model-router` do perfil. | Conta com essa árvore resulta em `CONFIG_UNVERIFIABLE` (AC-08), sem tentar contornar. |

## Decisões de arquitetura

- **AD-1. Um módulo puro de roteamento** (`scripts/lib/model-routing.js`) reúne a
  resolução §4.7, a RoutingDecision e o argv roteado. Ele **reusa**
  `classifyByRules` do `would-route.js` e o loader de `model-routing-policy.js`:
  as regras R1–R8 não são duplicadas e nenhum loader paralelo é criado. Entra no
  `ownership.yaml` e no baseline do dependency-cruiser.
- **AD-2. Config do consumidor:** `routing` fica num arquivo versionado do
  consumidor, declarado no `config-contract.json` dele:
  `{ mode, policy_ref: { id, version, sha256, path } }`. A validação é uma regra
  nova no `config-validator.js` existente, e a admissão chama **a mesma função**:
  o check de config e o watcher não podem divergir.
- **AD-3. Curto-circuito OFF:** a primeira operação do roteamento é ler `mode`.
  Se estiver ausente ou `OFF`, retorna antes de qualquer outra E/S e o despacho
  segue pelo código atual, sem tocar no argv. O golden da T1 prova isso.
- **AD-4. Snapshot `routing`:** é fixado na admissão da Run como um objeto
  canônico com sha256, gravado no `admission.snapshot` do Attempt `fetch_ticket`
  (owner DOM06) e copiado byte a byte, com o mesmo sha, para cada Attempt de nó.
  Snapshot ilegível ou com sha divergente resulta em `CONFIG_UNVERIFIABLE`. Não
  há caminho de código que leia a config corrente depois da admissão.
- **AD-5. Mecanismo de esforço como capacidade injetada:** `effortMechanism` é
  parâmetro das funções puras. Em produção, nesta fatia, vale sempre
  `UNAVAILABLE`. **Não existe env var nem flag que ligue o mecanismo em
  produção**, para não criar porta dos fundos. O caminho feliz (AC-02) é provado
  no nível de unidade, com mecanismo injetado. No watcher, os testes cobrem OFF e
  as recusas.
- **AD-6. Prova do plugin:** o despacho roteado grava `routing-settings.json` no
  diretório da Run, com o `jev-model-router` desligado, faz o hash, relê e confere
  antes do spawn, e passa `--settings <arquivo>`. A conta do despacho é
  inspecionada pelas três fontes (`detectEffortRouterPlugin`). Se houver
  `skills/jev-model-router` ou `pluginConfigs` ligado, a carga não é
  neutralizável e o resultado é `CONFIG_UNVERIFIABLE`.
- **AD-7. Mapeamento de esforço:** a policy usa `baixo/médio/alto/máximo`, e o
  mapeamento para o vocabulário do CLI fica na policy, não no código. Nesta fatia
  só se valida que ele é total. O uso real depende da P-1.
- **AD-8. `escalation`:** o DOM06 ganha `RESERVED_CAUSES = {'escalation'}`;
  `beginAttempt`, `retryAttempt` e `prepareDispatch` recusam com erro explícito e
  sem gravar Attempt. `escalation_proposal` vira só um validador de forma, sem
  produtor.

## Grafo de dependências

```
T1 golden AS-IS ───────────────────────────────────────────┐ (rede de segurança: tudo depende)
T2 config/policy ON ──┬── T3 resolver §4.7 ──┬── T5 snapshot ── T6 admissão ── T7 despacho por nó ── T9 dashboard
T4 escalation/NOT_STARTED (DOM06) ───────────┘                                 │
                                         T8 override (bloqueada por P-2) ──────┘
                                                                                └── T10 verificação + handoff
```

T2 e T4 podem andar em paralelo, e T3 depende de T2. T5 → T6 → T7 é a cadeia
crítica e mexe no `readmine-watcher.js`: é sequencial, com um writer só.

## Lista de tarefas (índice; detalhes em [todo.md](todo.md))

### Fase 0: rede de segurança
- [ ] T1: golden de argv/env do AS-IS (mode ausente e OFF)

### Fase 1: fundação pura
- [ ] T2: validação de `routing` e policy para `mode = ON`
- [ ] T3: resolver §4.7 e RoutingDecision
- [ ] T4: DOM06, `NOT_STARTED` e reserva de `escalation`

**Checkpoint A:** suítes de scripts e dashboard verdes, `check:js`, `arch:check` e
`lint:src` limpos, golden da T1 inalterado. Revisão humana antes da fase 2.

### Fase 2: ligação no despacho
- [ ] T5: snapshot `routing` na admissão e ligação à task
- [ ] T6: bloqueio de admissão e aviso único por projeto
- [ ] T7: despacho por nó com resolução, recusas e RoutingDecision

**Checkpoint B:** AC-01 e AC-03 a AC-08 verdes no watcher com stub; golden
inalterado; revisão independente intermediária (Claude) por ser G3 no escritor de
Attempt.

### Fase 3: override, visibilidade e fechamento
- [ ] T8: override humano (bloqueada até a P-2)
- [ ] T9: bloqueio de admissão visível no Dashboard
- [ ] T10: verificação completa, evidência e handoff

**Checkpoint final:** AC-01 a AC-13, Review (Claude) + 2º revisor (Arquiteto),
Test, Verify, Commit e handoff.

## Riscos e mitigações

| Risco | Impacto | Mitigação |
| -- | -- | -- |
| Regressão no despacho atual (`readmine-watcher.js`, 4,5k linhas) | Alto | T1 antes de tudo; curto-circuito OFF (AD-3); toda mudança no watcher fica atrás de `mode = ON`. |
| Ligação snapshot → task: o task-id nasce no agente | Alto | T5 liga pelo Attempt `fetch_ticket` (id e sha). Sem ligação provada no primeiro nó da task, o resultado é `CONFIG_UNVERIFIABLE`, nunca releitura. |
| `NOT_STARTED` em loop a cada tick | Médio | T7: o primeiro `NOT_STARTED` bloqueia a Run pelo caminho humano existente, com um aviso por assinatura. |
| O writer da override não existe no formato exigido (`quem`/`quando`/`escopo`) | Médio | T8 bloqueada até a P-2. A fatia pode ser entregue sem T8 só com a decisão explícita do Richard. Nunca criar canal novo. |
| `mode = ON` inoperante em produção (SP-1 + policy `UNAVAILABLE`) | Esperado | Declarado no SPEC; a P-1 pode mudar isso. |
| Porta dos fundos de teste para o mecanismo de esforço | Alto | AD-5: só injeção por parâmetro, sem env. |
| Módulo novo fora do `ownership.yaml`/baseline do cruiser | Baixo | T3 registra os dois. |
| Estimativa acima de 5 pontos | Médio | 10 tarefas, sendo T5–T7 as maiores. Se T8 crescer, dividir a issue (T8 numa sub-issue). |

## Perguntas em aberto (precisam do Richard ou do Arquiteto)

- **P-1. U1 e `--effort`.** O CLI 2.1.319 tem `--effort <low|medium|high|xhigh|max>`.
  Ainda não se sabe se o transcript informa o esforço efetivo. Manter a SP-1 como
  está (mecanismo `UNAVAILABLE` em produção nesta fatia) ou abrir um spike curto e
  separado para verificar o U1 e, depois, ligar o mecanismo por versão de CLI
  verificada? **Recomendo** manter a S4 como está e registrar o achado no U1 da
  PRI-205.
- **P-2. Writer da override (DP-5).** O único writer humano governado que existe é
  o `authorization.js`: endpoints do dashboard, aprovador autenticado, CAS e
  `authorization_history`. Mas ele coloca a Run em `authorization-pending`, o que
  pausa o ciclo. As opções são:
  - (a) estender esse writer com `kind: routing_override`, sem pausar a Run;
  - (b) override como entrada versionada na config do consumidor, sem
    `quem`/`quando` durável;
  - (c) adiar a T8 para outra issue.
  **Recomendo** a (a), com o Arquiteto confirmando que fica dentro da baseline. A
  (b) não satisfaz o `override_ref`.
- **P-3. Nome e lugar do arquivo `routing` no consumidor** (AD-2). Mexe na config
  do app-back, que é "perguntar antes". Sugestão: `.claude/model-routing.json`.
- **P-4. Ligação snapshot → task (AD-4/T5).** Usa um campo `routing_snapshot` no
  `state.json` (via `state-writer`) ou o diretório `_dom06` do ticket? Os dois
  mudam o schema dentro do que o SPEC permite. A T5 propõe o `state.json` porque o
  dashboard já lê de lá.
