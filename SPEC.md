# Spec: PRI-233 — PRI-205 S4: roteamento com flag (`mode`, snapshot `routing`, bloqueio de admissão)

> **Status:** APROVADA pelo Richard em 2026-11-06, com as premissas A1–A5 como
> escritas. As perguntas em aberto 3 a 6 continuam pendentes e vão para o plano e
> para a reconciliação. A aprovação da spec não é Ready da issue, não é aprovação
> do plano e não é SDD do Arquiteto. Não é SDD aprovada,
> não aplica RC-1 a RC-6 (todos NOT APPLIED), não altera o desenho v9, a F13 nem o
> Roadmap. `roadmap-ref: UNKNOWN` (baseline F13 Agent Runtime; ID e versão a
> confirmar antes do Ready).
>
> **Fontes:** [PRI-233](https://linear.app/prisma-app/issue/PRI-233/pri-205-s4-infraestrutura-de-roteamento-com-flag-mode-snapshot-routing),
> PRI-205 (decisões D1–D23, DP-1–DP-10, R-1–R-7, D-1–D-10), desenho v9 §4.6, §4.7,
> §6.3 (`~/Workspace/prisma-evidence/pri-205/desenho-selecao-modelo.md`),
> `plano-fatias.md` §S4, `hd-ativacao-final-proposta.md` (HD-AF-078), código da S3
> (PR #78: `scripts/lib/would-route.js`, `scripts/lib/model-routing-policy.js`) e
> PRI-214 (MINOR-1 corrigido, Done).

## Contexto

Hoje (AS-IS) o watcher despacha `claude -p` sem `--model` nem esforço: o modelo é
o herdado da conta, e o registro do Attempt grava `selection_source =
DEFAULT_INHERITED` e `routing_decision = UNAVAILABLE`. A S3 (PRI-223, Done) já
carrega uma policy versionada com hash e calcula a decisão sombra `would_route`
por subtarefa, mas nunca a aplica. A policy de sombra ainda tem todos os modelos
como `UNAVAILABLE` e o U1 continua sem solução: não há mecanismo verificado para
fixar o esforço no `claude -p`, então o esforço pedido é `UNAVAILABLE`.

A S4 leva o roteamento até o despacho atrás de uma flag. Desligada, nada muda.
Ligada, o despacho só acontece se tudo o que o §4.7 exige estiver provado. Caso
contrário, o despacho é recusado de forma determinística e com caminho humano.

## Objetivo

Com `routing.mode` ausente ou `OFF` em um projeto consumidor, todo despacho
continua idêntico ao AS-IS. Com `mode = ON` e policy válida, cada Attempt recebe o
par (modelo, esforço) resolvido de forma determinística e fixado no despacho, e
uma RoutingDecision completa fica gravada. Se uma pré-condição não puder ser
provada, o Attempt não inicia, com uma causa da F13, e nenhuma Run nova é
admitida sobre uma policy inválida.

**Consequência (revista em 2026-11-06, SP-1):** com o U1 aberto, o despacho roteado
vai só com `--model` e `--settings`; o esforço fica registrado como não aplicado.
Ativar em um consumidor real depende da policy aprovada (antes da S6), fora desta
fatia. ~~Antes: `mode = ON` resultava em `NOT_STARTED / CONFIG_UNVERIFIABLE` em todo
despacho roteado.~~

## Decisões tomadas nesta spec (Richard, 2026-11-06)

| ID | Pergunta | Decisão |
| -- | -- | -- |
| SP-1 | Esforço com o U1 sem solução | **Revista pelo Richard em 2026-11-06:** "o esforço hoje é menos relevante que o modelo; pode ser adiado". Sem mecanismo de esforço verificado, o despacho roteado vai **só com o modelo** (`--model`) e registra o esforço como não aplicado (`effort_applied: false`, `requested.effort = UNAVAILABLE`). O plugin provado desligado (SP-2) continua obrigatório. ~~Antes: bloquear o despacho roteado; nunca rotear só o modelo.~~ |
| SP-2 | Prova do plugin desligado | **`--settings` próprio do despacho**, gerado pelo Prisma, que desliga o `jev-model-router`. O Prisma verifica esse arquivo, e a prova não depende do perfil da conta. |
| SP-3 | Onde fica `mode` e qual é o raio | **Por projeto consumidor**, em `routing` na configuração versionada do consumidor, validada pelo check de configuração existente (`config-contract`). A policy inválida bloqueia a admissão de novas Runs só daquele projeto. |
| SP-4 | Pedido humano de Run não admitida (R-5) | **Canal existente de pendência humana**: comentário no Redmine, notificação e visibilidade no Dashboard. Um aviso por escopo, sem vocabulário novo e sem estado de Run novo. |

## Premissas (corrigir antes da aprovação, senão valem)

- **A1. Unidade de roteamento na S4 = Attempt de nó.** Subtarefas como Attempts só
  entram na S5. No nó Implement, a classe do Attempt é a **máxima** entre as classes
  dos grupos de subtarefa da S2/S3, para errar para cima, como na nota humana de
  05/11. Sem sinais, ou com sinal UNKNOWN, a classe é C4 com
  `selection_source = CONSERVATIVE_DEFAULT` (§4.7, passo 4).
- **A2. Plan, gates e demais nós ficam fixos (D6)** no `default_route` explícito da
  policy (T3), que vai no despacho como `--model` e esforço. Com `mode = ON`,
  nenhum nó termina em modelo herdado (guarda 3).
- **A3. O núcleo 1 (R1–R8) sempre roda com `mode = ON`.** `classifier.provider` só
  governa o núcleo 2 (zona cinzenta). Na S3, `off` significava "sem decisão" para
  tudo. A S4 separa os dois, sem mudar o comportamento sombra da S3 com
  `mode = OFF`.
- **A4. `classifier.provider = jev`:** a admissão reavalia a Authority Ref (RC-6).
  Se ela estiver ausente ou inválida, o efetivo é `off`, gravado com o motivo.
  `jev` não torna a policy inválida e nenhuma chamada ao Jev acontece na S4.
- **A5. A override usa um writer/canal de decisão humana que já existe** (DP-5),
  sem canal novo. Nos testes, os escopos são ticket, nó e subtarefa. Na S4 o
  escopo subtarefa só casa quando houver `subtask_key` no Attempt (S5), então hoje
  só ticket e nó têm efeito real.

## Escopo

**Entra:**

1. `routing.mode` (`ON`/`OFF`) por projeto consumidor, com a referência da policy
   (`id`, `version`, `sha256` aprovado). `mode` ausente = OFF, e nesse caso a policy
   não é lida para roteamento. `mode` presente e malformado conta como inválido.
   Tudo é validado pelo check de configuração existente, sem validador paralelo.
2. Snapshot `routing` imutável, fixado na admissão da Run: `mode`, `policy_ref`,
   `default_route` explícito e `eligible_set_ref`. Run já admitida nunca troca de
   snapshot.
3. Bloqueio de admissão (RC-5/D12 b/DP-3): com `mode = ON` e policy ausente, de
   schema inválido ou com hash divergente do aprovado, a Run **não é admitida**
   (nenhuma Run é criada) e o pedido humano vai pelo canal de SP-4. Escopos com
   `mode` OFF seguem normalmente. Runs em andamento não mudam.
4. Resolução do §4.7 no início de cada Attempt, antes do spawn: (1) snapshot
   legível e íntegro, (2) provider elegível, (3) override humano, (4) classificadora,
   (5) candidatos do tier na ordem da policy, subindo de tier e nunca descendo.
5. Par (modelo, esforço) fixado no despacho e constante durante o Attempt.
   Mecanismo de esforço não verificado leva a `CONFIG_UNVERIFIABLE` (SP-1).
6. Plugin `jev-model-router` desligado e provado via `--settings` próprio (SP-2).
   Se não der para provar, `CONFIG_UNVERIFIABLE`.
7. RoutingDecision gravada no registro do Attempt (o campo `routing_decision` que
   já existe) com `policy_ref`, `eligible_set_ref`, classe, hash dos sinais,
   candidatos com motivo de descarte, escolhido, `selection_source`, `override_ref`
   e o estado do plugin e do mecanismo de esforço.
8. Subagente declarado `UNENFORCED` na RoutingDecision (RC-1/DP-4b).
9. Causa `escalation` e registro `escalation_proposal` só **reservados** no
   vocabulário (RC-2/D-5). Nenhum Attempt `escalation` pode ser criado.
10. Override humano com precedência subtarefa > nó > ticket, valendo a partir do
    próximo limite de nó, na mesma Run e com o snapshot intacto (D-4).
11. Reavaliação da Authority Ref para `jev` na admissão (RC-6), conforme A4.

**Não entra:** subtarefas como Attempts (S5); Attempt `escalation` efetivo (S5b);
piloto (S6); seletor do classificador no Dashboard (S7d); qualquer chamada ao Jev;
aprovar a policy real ou escrever ids de modelo nela; resolver o U1; editar o
Roadmap; aplicar formalmente os RCs (PRI-232); fallback entre providers (o piloto
tem um provider só).

## Critérios de Aceite

- AC-01: Com `routing` ausente ou `mode = OFF`, para cada nó do grafo (inclusive
  os caminhos de retry, timeout e resume), argv, env, modelo e esforço do despacho
  são byte a byte iguais aos do AS-IS. O registro do Attempt continua com
  `selection_source = DEFAULT_INHERITED` e `routing_decision = UNAVAILABLE`, e a
  sombra `would_route` da S3 continua como está.
- AC-02: Com `mode = ON`, policy válida, mecanismo de esforço sintético verificado e
  plugin provado desligado, o despacho do Implement leva o modelo e o esforço
  resolvidos pelo §4.7, e o argv inclui o `--settings` gerado. A RoutingDecision
  traz `policy_ref` (id, versão, sha256), `eligible_set_ref`, classe, hash dos
  sinais, candidatos com motivo de descarte, escolhido, `selection_source`,
  `override_ref` (ou null), `subagent = UNENFORCED`,
  `effort_router_plugin = NOT_LOADED` com referência à prova e o mecanismo de
  esforço usado.
- AC-03: Com `mode = ON`, os nós Plan, Review, Test e Verify (e os demais fora do
  Implement) são despachados no `default_route` explícito da policy, com
  `selection_source` indicando rota fixa (D6). Nenhum despacho com `mode = ON` sai
  sem `--model`.
- AC-04: Na admissão de uma Run nova com `mode = ON` e policy ausente, de schema
  inválido, com hash diferente do aprovado ou com `mode` malformado, nenhuma Run é
  criada, nenhum nó é despachado e um único pedido humano por projeto vai pelo
  canal existente, com projeto, causa e detalhe. Um projeto com `mode` OFF na mesma
  máquina segue admitindo, e uma Run já admitida do projeto bloqueado continua com
  o snapshot original.
- AC-05: Corromper ou apagar o snapshot `routing` de uma Run admitida faz o
  próximo Attempt terminar em `NOT_STARTED / CONFIG_UNVERIFIABLE`, sem spawn. O
  teste prova que a configuração corrente do repositório e da conta não é relida,
  mesmo quando ela é válida.
- AC-06: Provider desabilitado, override inelegível ou nenhum candidato elegível
  em tier igual ou acima do da classe resultam em
  `NOT_STARTED / PROVIDER_NOT_ELIGIBLE`, sem spawn e sem troca silenciosa de modelo.
- AC-07 (revisto em 2026-11-06, SP-1): Sem mecanismo de esforço verificado (o estado
  de produção hoje, U1), um despacho com `mode = ON` e plugin provado desligado sai
  com `--model` e `--settings`, sem `--effort`; a RoutingDecision registra
  `effort_applied: false` e o registro de custo `requested.effort = UNAVAILABLE`.
  ~~Texto original: termina em `NOT_STARTED / CONFIG_UNVERIFIABLE` com o motivo
  `EFFORT_MECHANISM_UNAVAILABLE`, sem cair para despacho só com `--model`.~~
- AC-08: Se o `--settings` gerado não puder ser escrito ou verificado, ou se a
  prova de que ele neutraliza as três fontes de carga do plugin (`enabledPlugins`,
  `pluginConfigs`, árvore `skills/jev-model-router`) não valer para a conta do
  despacho, o resultado é `NOT_STARTED / CONFIG_UNVERIFIABLE` com
  `effort_router_plugin ≠ NOT_LOADED` registrado.
- AC-09: Na resolução, override de subtarefa vence o de nó, que vence o de ticket.
  Uma override registrada durante um nó em execução não altera esse Attempt e
  passa a valer no próximo limite de nó da mesma Run, com o snapshot intacto (D-4).
- AC-10: Tentar abrir um Attempt com causa `escalation` por qualquer função do
  escritor DOM06 é recusado, sem gravar Attempt. O schema aceita um registro
  `escalation_proposal`, mas nenhum caminho de código o transforma em despacho.
- AC-11: Com `classifier.provider = jev` e Authority Ref ausente ou inválida na
  admissão, o classificador efetivo é `off`, a RoutingDecision registra o motivo e
  nenhuma requisição de rede ao Jev/TypeSafe acontece. O teste roda sob o harness
  loopback-only.
- AC-12: Para o mesmo snapshot, os mesmos sinais e as mesmas overrides, a
  resolução devolve sempre o mesmo par e a mesma lista de candidatos (determinismo,
  com tie-break pela ordem declarada).
- AC-13: As suítes existentes de `scripts/` e `dashboard/`, o `check:js`, o
  `arch:check` e o `lint:src` passam sem teste removido, pulado ou enfraquecido.

## Tech Stack

Node 20.20.2 / npm 10.8.2 (versões da extração), CommonJS, sem dependência nova.
Dois pacotes separados (`scripts/`, `dashboard/`) e nenhum runner de raiz. Testes
com o runner `harness/run-tests.js` (HOME/TMPDIR sintéticos, loopback-only). Ajv
opcional, como no `config-validator`.

## Comandos

```bash
cd scripts && npm test            # suíte scripts via harness/run-tests.js
cd dashboard && npm test          # suíte dashboard
cd scripts && npm run check:js    # tsc checkJs
cd scripts && npm run arch:check  # dependency-cruiser contra a baseline
cd scripts && npm run lint:src
node scripts/validate-config.js --severity error --config <consumidor>/.claude/config-contract.json
node scripts/lib/dom06-attempt.test.js   # foco, durante o desenvolvimento
```

## Estrutura do projeto (onde a mudança deve cair)

O que fica fixo é o **o quê**. Nomes e arquivos exatos são do plano.

```
scripts/lib/dom06-attempt.js        → admissão/escritor do Attempt (owner existente): reserva de escalation, causas NOT_STARTED
scripts/lib/model-routing-policy.js → loader/validador de policy da S3, estendido para mode ON (sem loader paralelo)
scripts/lib/would-route.js          → classificadora R1–R8 reutilizada pela resolução real (sem duplicar regras)
scripts/lib/claude-account.js       → prova do plugin desligado (SP-2)
scripts/lib/config-validator.js     → regra nova para `routing` no check de config existente
scripts/lib/cost-tracking.js        → preenche `routing_decision` / `selection_source` no registro do Attempt
scripts/readmine-watcher.js         → admissão da Run e montagem do argv do despacho
scripts/**/<módulo>.test.js         → testes ao lado do módulo, registrados no `npm test` do pacote
dashboard/                          → só a visibilidade do bloqueio de admissão (SP-4), reusando telas existentes
```

Nenhum dado, credencial, policy real ou configuração do consumidor entra neste
repositório. As fixtures de policy, de `routing` e de conta são sintéticas.

## Estilo de código

Mantenha o padrão do código da S3: CommonJS, 4 espaços, comentários em português
com a referência da issue, constantes congeladas, funções puras devolvendo
`{ ok, cause, detail }` e nunca exceção como fluxo de decisão. UNKNOWN e UNAVAILABLE
são valores explícitos e nunca viram `0`, `false` ou aprovação.

```js
// PRI-233 S4: a prova do plugin desligado vem do --settings do próprio despacho.
// Sem prova → CONFIG_UNVERIFIABLE. Nunca relê a config corrente da conta.
function verifyRoutedPreconditions(snapshot, probe) {
    if (!snapshot || snapshot.sha256 !== probe.snapshotSha256) {
        return { ok: false, cause: 'CONFIG_UNVERIFIABLE', detail: 'snapshot_unreadable' };
    }
    if (probe.effortMechanism !== 'VERIFIED') {
        return { ok: false, cause: 'CONFIG_UNVERIFIABLE', detail: 'EFFORT_MECHANISM_UNAVAILABLE' };
    }
    return { ok: true };
}
```

## Estratégia de testes

- **Unidade** (`*.test.js` ao lado do módulo): resolução do §4.7 passo a passo,
  com um caso por desfecho; precedência e vigência da override; classe do
  Implement = máxima; determinismo; validação de `routing` e da policy para
  `mode = ON`; reserva de `escalation`.
- **Contrato de despacho:** um teste de igualdade de argv/env com `mode` OFF e
  ausente, cobrindo todos os nós e as causas `dispatch`, `retry`, `timeout` e
  `resume`, contra um golden capturado do AS-IS **antes** da primeira mudança
  (AC-01).
- **Integração no watcher** (modo SIMULATE/dry-run existente, sem `claude` real):
  bloqueio de admissão sem criar Run e com um aviso por escopo; Run em andamento
  com snapshot intacto; snapshot corrompido sem releitura da config.
- **Fixtures sintéticas:** policy com ids de modelo fictícios, um mecanismo de
  esforço sintético marcado como verificado (só em teste), contas sintéticas com
  cada uma das três fontes do plugin. Nenhum teste usa conta, policy ou rede reais.
- O TDD vale para cada AC: o teste nasce falhando. As suítes completas rodam
  antes do pedido de review.

## Fronteiras

- **Sempre:** `mode` ausente = OFF; preservar snapshot e Context Record imutáveis;
  estender os owners existentes (DOM06, check de config, loader da S3) e nunca
  criar engine, registry, validador ou canal paralelo; registrar
  UNKNOWN/UNAVAILABLE de forma explícita; seguir Plan → Implement → Review
  independente (Claude + Arquiteto como 2º revisor, perfil G3) → Test → Verify →
  Commit; entregar o handoff de `docs/handoff-contract.md`.
- **Perguntar antes:** ligar `mode = ON` em qualquer consumidor real; escrever ids
  de modelo ou esforço reais em qualquer policy; adicionar dependência; mudar o
  schema de `state.json`/Attempt além dos campos `routing`, `routing_decision` e
  `escalation_proposal`; mudar o CI; alterar o comportamento sombra da S3 com
  `mode = OFF`; qualquer impacto além da baseline (volta para a reconciliação).
- **Nunca:** chamar o Jev/TypeSafe; criar Attempt `escalation`; reler a
  configuração corrente para reconstruir um snapshot; trocar o modelo
  silenciosamente; despachar roteado sem o plugin provado desligado; fazer rebind
  automático ou repetir efeito de resultado incerto; tratar RC-1 a RC-6 ou
  RRC-F31-001/002 como aplicados; editar o Roadmap; commitar dado ou credencial
  do consumidor.

### Diretrizes R-6 (mitigações do RC-5, não contrato)

1. Validar `routing` e a policy na escrita, pelo check de config, antes da
   admissão.
2. Raio por escopo: só o projeto com `mode = ON` é bloqueado.
3. A saída humana registrada é ligar `mode = OFF` no projeto, de forma explícita.
4. A última versão válida da policy aparece só como sugestão, nunca é aplicada.
5. Um aviso por escopo, sem repetir a cada tick.
6. Separar leitura transitória (I/O) de hash divergente; a primeira não pode
   virar falso "policy inválida" sem nova tentativa limitada.
7. O bloqueio aparece no Dashboard.
8. Testes sintéticos para cada desfecho.

## Critérios de sucesso

- AC-01 a AC-13 verdes, com evidência (saída dos comandos acima) atribuída ao
  commit da PR e anexada à PRI-233.
- O golden de argv do AS-IS foi capturado antes da mudança e continua igual depois.
- O parecer da Review independente e o do 2º revisor (Arquiteto) estão sem
  bloqueio.
- O handoff foi entregue a partir de `templates/handoff.yaml.template`.

## Perguntas em aberto

1. **Premissa A1.** A classe do Attempt do Implement é a máxima dos grupos, ou o
   Implement fica em `default_route` até a S5?
2. **Premissa A3.** A separação entre núcleo 1 (sempre ativo) e `classifier.provider`
   (só o núcleo 2) diverge da semântica implementada na S3 (`off` = sem decisão).
   É preciso confirmar que essa é a leitura do v9 §4.8 e da D23.
3. **Admissão da Run.** No AS-IS a admissão é por Attempt (DOM06), e a Run nasce
   quando o watcher cria a task do ticket. O ponto exato de "não criar Run" fica
   para o plano. A reconciliação (R-5, RRC-AR-004/DIV-AR-002) ainda precisa
   confirmar a forma "recusa sem criar Run".
4. **Writer da override (A5).** Qual writer de decisão humana existente recebe a
   override (DP-5)? Se não houver um adequado, isso é impacto além da baseline e
   volta para a reconciliação.
5. **SP-2 contra a árvore `skills/`.** Ainda não foi verificado se um `--settings`
   consegue neutralizar a carga do `skills/jev-model-router` no perfil. Se não
   conseguir, toda conta com essa árvore cai em `CONFIG_UNVERIFIABLE` (AC-08), e é
   preciso decidir se isso basta.
6. **`roadmap-ref`** e o ID/DR da HD-AF-078 (DP-7), a cargo do Coordenador.
7. **Estimativa:** 5 pontos (faixa 3 a 8) segundo o Arquiteto. A SP-1 reduz um
   pouco (sem spike de U1), e a SP-2, a A3 e a A4 aumentam.
