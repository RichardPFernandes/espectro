# SDD: Esforço fixo por fase no fluxo de código do Espectro

> **Status:** v0.3. D1–D8 aprovadas pelo Richard em 14/11/2026 com as recomendações. Benchmark
> visual: harness + página sem dado inventado (AC8). Nada implementado. Issues: PRI-353 (Médio,
> esta fatia) e PRI-354 (Alto, ligar a flag e rodar o piloto), filhas da PRI-352, que já governa o roteamento de
> modelo. Código lido em `main` `a2e956b`. Objetivo: **velocidade e limite de uso da assinatura**, não custo em dinheiro.

## Nível de processo

PRI-353 (esta fatia, muda o despacho atrás de flag desligada): **Médio**. PRI-354 (ligar a
flag no consumidor piloto e rodar o piloto): **Alto**, com AUTORIZO próprio (regra 7).

## Contexto (AS-IS)

- Grafo: `plan → implement → review → test → verify → commit` (`.graph/graph.yaml`;
  `fetch_ticket` é só a entrada do ticket). Análise de negócio e planejamento de produto não
  fazem parte dele.
- O watcher despacha **um `claude -p` por nó** (`readmine-watcher.js:5271`, `nodes: [node]`).
  Plan e implement são sessões separadas; o review já roda em sessão nova.
- O esforço **não é aplicado**: `PRODUCTION_EFFORT_MECHANISM = UNAVAILABLE (U1_UNVERIFIED)`
  (`model-routing.js:35`). O despacho roteado leva só `--model`, e `effort_applied` fica `false`.
  A policy já traz o mapa `baixo/médio/alto/máximo → low/medium/high/max`.
- `plan.md` já é um artefato de handoff (diagnóstico, arquivos, riscos técnicos, plano de
  execução, cobertura dos ACs). Não tem seção própria de decisões.
- `plan` não pode abrir subagente (`NO_SUBAGENT_NODES`, `subagent-block.js`).

## Objetivo

Cada fase do fluxo de código roda num esforço fixo, escolhido por tabela. As fases em esforço
alto terminam num artefato de handoff. Quando uma fase em esforço médio erra algo que esforço
alto pegaria, isso fica registrado. Esse registro é a base para decidir escalada no futuro.

## Desenho

1. **Tabela de esforço por fase** (palpite meu, ver D1), em arquivo de config versionado:

   | Fase | Esforço | Por quê |
   | -- | -- | -- |
   | plan + implement | alto | decide o HOW e escreve o código; erro aqui custa mais |
   | review | alto | única barreira independente |
   | test | médio | escreve e roda teste contra ACs já definidos |
   | verify | médio | confere matriz contra a spec |
   | commit | baixo | mecânico |

2. **Mecanismo (pré-requisito, U1).** Antes de qualquer outra coisa, provar **como** fixar o
   esforço no `claude -p` do despacho. Sem isso, a tabela não tem efeito e o resto é papel.
   Enquanto U1 estiver aberto, a flag fica desligada e o despacho é o AS-IS, byte a byte.
3. **Handoff das fases em esforço alto.** O raciocínio não passa para o próximo turno, então a
   fase grava no fim um artefato com: plano, decisões tomadas, riscos, arquivos afetados.
   Para plan+implement, reaproveitar o `plan.md` e acrescentar uma seção `## Decisões`. Para
   review, o `review_results` já existente. Sem arquivo novo por fatia.
4. **Plan + implement na mesma sessão** (decisão sua). Hoje são dois despachos. A mudança é um
   segmento com `nodes: [plan, implement]`. Pontos a resolver no plano: o bloqueio de
   subagente do plan não pode valer para o implement; lease, admissão DOM06 e `node_events`
   são por nó e precisam registrar os dois.
5. **Review com contexto limpo** (decisão sua). Já é verdade hoje, porque o review é sessão
   nova. Ver D2 sobre ser sessão despachada ou subagente.
6. **Registro de erro em esforço médio.** Campo `effort_miss` por fase em esforço médio, só
   preenchido por quem detecta o erro (review, verify ou humano):
   `{ phase, effort, what_missed, would_high_catch: yes|no|unknown, class, evidence_ref }`.
   `would_high_catch` começa `unknown`: o que esforço alto teria pego **não é observável**,
   é julgamento registrado, nunca inferido. Ausência de registro não é zero (vale como
   UNKNOWN). O registro só cobre fases em médio.

## Critérios de aceitação

- **AC1.** Existe prova, com versão do Claude Code, de como o esforço é fixado por despacho,
  ou a prova de que não dá (U1 fechado como UNAVAILABLE). Verificação: probe offline +
  evidência no PR.
- **AC2.** Com a flag desligada, o argv e o comportamento do despacho são idênticos ao AS-IS.
  Verificação: teste de golden do argv.
- **AC3.** Com a flag ligada e U1 verificado, cada nó recebe o esforço da tabela e a decisão
  grava `effort_applied: true` com o valor aplicado. Verificação: teste unitário + 1 run
  simulada.
- **AC4.** Fase em esforço alto grava o handoff com os quatro campos. Verificação: validador
  que reprova artefato sem campo, só avisando na v1 (D7).
- **AC5.** Plan e implement rodam numa sessão sem que o bloqueio de subagente do plan vaze
  para o implement. Verificação: teste do argv do segmento.
- **AC6.** O registro `effort_miss` é gravado, validado e legível pelo dashboard.
  Verificação: teste do schema + leitura.
- **AC7.** O documento fixa o critério de reabertura da escalada dinâmica (seção abaixo).
- **AC8.** Ferramenta offline do piloto (N=10 runs pareadas, esforço fixo vs AS-IS) que gera
  uma página HTML com tempo, uso de limite, falhas e `effort_miss` por fase. Onde não há
  medição, a página mostra UNKNOWN, nunca zero nem valor de exemplo. Verificação: teste com
  fixtures sintéticas rotuladas e página gerada vazia (sem runs) mostrando só UNKNOWN. Rodar o
  piloto de verdade é a PRI-354 (Alto).

## Fora de escopo

- Escalada dinâmica de esforço (subir esforço no meio da fase).
- Análise de negócio e planejamento de produto.
- Ligar a flag em qualquer consumidor (Alto, AUTORIZO próprio).
- Medir custo em dinheiro.

## Quando reabrir a escalada dinâmica

Reabrir quando o registro mostrar um padrão, por exemplo (números são palpite, ver D5):
flag ligada em pelo menos 15 runs **e** 3 registros `yes` da mesma classe e fase, ou 20% das
runs de uma fase com `yes`. Com menos que isso, o registro é UNKNOWN, não aprovação.

## Riscos

- U1 pode não ter solução: a spec então termina em "não dá hoje", com a evidência.
- Esforço alto em plan+implement numa sessão só pode estourar o contexto; o handoff mitiga,
  não elimina.
- `effort_miss` depende de quem registra; viés para subnotificar.

## Decisões

Aprovadas em 14/11/2026: D1 a D8, todas como recomendadas. D6 aplicada: PRI-353 e PRI-354.
Texto original abaixo, para referência.

- **D1. Tabela de esforço.** Recomendo a da seção Desenho; é palpite e o piloto corrige.
- **D2. Review como sessão despachada ou subagente.** Recomendo manter **sessão despachada**:
  já tem contexto limpo, aceita esforço próprio por despacho e não depende de a sessão que
  implementou chamar o revisor. Subagente exigiria remover o bloqueio de Agent e ainda
  herdaria o esforço da sessão pai.
- **D3. Encadear plan+implement.** Recomendo encadear só depois de AC1 e AC5 passarem.
- **D4. Onde mora o registro.** Recomendo em `state.json` da run, com export para o dashboard.
- **D5. Números da reabertura.** Recomendo os acima; rever após o piloto.
- **D6. Issue.** Recomendo criar filha da PRI-352 com `Processo: Médio` para a fatia e abrir
  outra `Alto` só para ligar a flag.
- **D7. Lint do handoff.** Recomendo avisar sem bloquear na v1.
- **D8. Piloto.** Recomendo N=10 runs pareadas (esforço fixo vs AS-IS), com tolerância a falha
  de run por causa externa. Piloto no watcher é Alto.
