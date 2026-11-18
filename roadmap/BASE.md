# Base do roadmap: por que ele é o que é

> Estudo de 15/11/2026 sobre a `main` em `a4e3899`. Registro durável do diagnóstico, das
> correções e dos candidatos que deram origem ao [`ROADMAP.md`](../ROADMAP.md).

**Método.** Quatro estudos (código, produto, referências externas, ideias), cada um revisado
por um revisor independente na fonte primária, e depois consolidados em 35 candidatos.
Onde estudo e revisão divergiram, vale a revisão. Nada foi executado: "funciona" significa
chamador no caminho padrão e testes presentes. Nenhum dado de run real foi lido.

**Como ler as evidências.** `arquivo:linha` vale para `a4e3899`; a `main` já andou e as
linhas podem ter deslocado poucas posições. Confiança: **V** = verificado por revisor na
fonte; **P** = provável (um estudo afirma, ninguém conferiu); **H** = hipótese a medir.

## 1. Diagnóstico

**Tese.** O Espectro mede bem e ainda não reduz nada. O gargalo é fechar o que já está
construído, não construir mais. Três consequências:

1. **Contenção antes de economia.** Todo merge chega ao consumidor, sem pin nem ponto de
   retorno; a flag é a única barreira e não tem lista; nenhum agente tem limite.
2. **Sem linha de base não há economia demonstrável.** Modelo padrão da conta, volume de
   runs e o próprio sentido de "custo" (D1) são desconhecidos.
3. **O maior valor por esforço já está no repo:** ligar, medir, limitar e podar. Construção
   nova só em três pontos: portão de build, fila única e projeto-amostra.

**O que funciona (V).** O ciclo ticket → PR roda de ponta a ponta, só sobre Redmine +
Bitbucket e para um consumidor. Estado autoritativo com schema, lease e recuperação de órfão.
Gates automáticos ligados por padrão. Custo medido por run, nó e tentativa.

### Fatos que condicionam o roadmap

| # | Fato | Evidência | Conf. |
| -- | -- | -- | -- |
| 1 | O despacho padrão não leva `--model` nem `--effort`: toda fase roda no padrão da conta, que ninguém identificou | `scripts/readmine-watcher.js:4379-4397` | V |
| 2 | Não há teto de custo, de turnos nem alarme. `--max-turns` só aparece numa sonda | busca por `max-turns` e `budget` em `scripts/` e `dashboard/`; `scripts/probes/plugin-neutralization-probe.js:174` | V |
| 3 | Nada encerra um agente vivo por tempo. O timeout de lease (60 min) só vale sem pid; o agente é destacado e o watcher sai | `scripts/lib/node-lease.js:268-275`, `scripts/readmine-watcher.js:3739-3747` | V |
| 4 | As alavancas de custo estão desligadas: esforço por fase, cadeia plan+implement e `permissions.deny` atrás de flag; roteamento e decomposição OFF quando `mode` falta | `scripts/lib/phase-effort.js:22`, `scripts/lib/subagent-block.js:21,30`, `scripts/lib/model-routing-policy.js:363` | V |
| 5 | Cinco flags de comportamento não estão no `.env.example` e não há lista única. A exceção é `WATCHER_RECUSA_QA_NOVO_CICLO` | `.env.example:213` | V |
| 6 | Esforço por fase põe plan, implement e review em `high`: se o padrão da conta for menor, ligar gasta mais. A SPEC mira velocidade e limite da assinatura, não dinheiro | `.claude/phase-effort.json`, `tasks/effort-por-fase/SPEC.md:6` | V |
| 7 | A cadeia plan+implement exige pular o pré-build e roteamento OFF; é inelegível no repo do Espectro (`mode: ON`) | `scripts/lib/plan-implement-chain.js:23-31` | V |
| 8 | A decomposição ficou alcançável em 15/11 e segue `off`; falta o PR que liga e as runs do piloto | `.claude/model-routing.json:2-6` | V |
| 9 | O roteamento trata todo `.java` como schema e nunca rebaixa trabalho Java, o caso do único consumidor (PRI-318) | `scripts/lib/schema-watcher.js`, `scripts/lib/classifier-gray-zone.js:34` | V |
| 10 | `permissions.deny` no plan foi medido sem ganho (32.223 × 32.387 tokens), com a ressalva de que o prompt era stub | `docs/historico/pri-315/evidence/README.md:7-13` | V |
| 11 | Não existe módulo Human Gate / Decision Center. Aceites de spec e plano são comentário no Redmine ou flag de CLI; o dashboard só aceita churn | `scripts/readmine-watcher.js:143-167`, `:2884`; `dashboard/server.js:1724` | V |
| 12 | Autorização humana estruturada existe para um único tipo de ação (`db_migration`) | `scripts/lib/authorization.js:43` | V |
| 13 | Só três status aparecem como "precisa de você"; o webhook cobre PR aberto, PR de alto risco e escalation | `dashboard/public/run-list-model.js:14`, `scripts/lib/cycle-notifications.js:3-6` | V |
| 14 | Acoplamento a Redmine/Bitbucket: 287 arquivos citam um dos dois (39% do repo), 70 módulos não-teste citam Redmine; PR só por Bitbucket; `scripts/src/ports/` vazio; abstração de tracker fora de escopo por decisão | `.claude/commands/commit.md:114`, `tasks/pri-341/SPEC.md:22`, `scripts/readmine-watcher.js:4384` | V |
| 15 | Tarefa sem ticket não é despachada. A costura existente é `redmineFetch`, que em simulação aceita fonte por arquivo | `dashboard/server.js:897-898`, `:2092-2093`; `scripts/readmine-watcher.js:108` | V |
| 16 | O writer de Self-SDD não tem chamador: cerca de 2,1 mil linhas (2.080 ou 2.351 conforme o filtro); a única referência externa é um teste | `scripts/state-concurrency.test.js:535` | V |
| 17 | O consumidor roda do checkout de desenvolvimento, sem pin, desde 05/11 (ratificado em 06/11, PRI-263). O README ainda cita um pin que não vale | `docs/consumer-operations.md:10-54`, `README.md:173` | V |
| 18 | A regra da PRI-263 exige que cada merge deixe a `main` rodável no consumidor sozinha. Explica parte da lentidão | `docs/consumer-operations.md:36-39` | V |
| 19 | O dashboard não tem autenticação por desenho. A fronteira é filtro de `Host`/`Origin`/`Sec-Fetch-Site`; `HOST` é configurável e fora de loopback o filtro é contornável | `dashboard/server.js:2`, `:910-941`, `:3856` | V |
| 20 | O agente herda quase todo o `.env` do consumidor, com chave do Redmine e token do Bitbucket, roda com `Bash` e `acceptEdits` e recebe texto de ticket no prompt | `scripts/readmine-watcher.js:3538-3545`, `:4383-4384` | V |
| 21 | O dependency-cruiser não roda no CI: 77 violações aceitas, nada em `.github/` | `.dependency-cruiser-known-violations.json`, `scripts/package.json:21` | V |
| 22 | O build só é conferido antes do implement. Erro de compilação aparece no nó test, depois de um review pago | `scripts/readmine-watcher.js:5218`, `scripts/lib/build-validator.js:1-8` | V |
| 23 | Recusas de QA não publicariam diagnóstico mesmo com a flag ligada: o modelo recusa a chave que a identidade gera | `scripts/lib/qa-diagnosis-model.js:59-65` | V |
| 24 | O weekly já mede primeira passada por run, retries por nó e gates abertos; declara o que falta (teto, custo do retrabalho, gates respondidos) | `dashboard/public/weekly-report.js:4-7`, `:106`, `:272`, `:282` | V |
| 25 | O custo em USD é imputado por tabela de preços sobre tokens. Na assinatura não é desembolso | revisão de código; revisão de referências | V |
| 26 | Segundo consumidor exige segunda instância de watcher e dashboard; tabela de esforço e aprovadores ficam globais | `scripts/lib/watcher-lock.js:1`, `dashboard/server.js:254` | V |
| 27 | 164 arquivos citam o consumidor (app-back). A fixture do modo simulado é sintética e limpa | revisão de ideias; `scripts/fixtures/ticket-example.json` | V |
| 28 | README diz "repo privado" e "não há licença pública"; o `LICENSE` é Apache-2.0 | `README.md:225`, `LICENSE:1-3` | V |
| 29 | Em seis semanas: 177 commits, 153 documentos no Linear, 363 issues criadas contra 164 concluídas; o cycle 3 foi de 21 a 73 issues, em cinco frentes | leitura do Linear na revisão de produto | V (números), P (leitura) |
| 30 | Não existe prova de valor contra usar o agente direto, nem meta numérica de custo | Plano de validação de valor; PRI-76, 81, 82 em Ready | V |

## 2. Correções aos estudos originais

O que caiu na revisão, e por quê:

- **"Consumidor fixado num pin, 152 commits atrás."** Falso na prática (fato 17). O problema
  é o inverso: tudo chega, sem ponto de retorno. Saiu a ideia de "aproximar o pin da main".
- **"Dois degraus de autorização mais bump."** Vale no papel; hoje a única barreira é a flag.
- **"Decomposição inalcançável."** Desatualizado (fato 8). E congelá-la "até haver n" é
  circular: sem ligar não há n.
- **"Três frentes a um passo do usuário."** Só a decomposição. Recusas de QA são 16 fatias;
  o viés `.java` é reconciliação, sombra e recalibração.
- **"Nó em laço para pelo timeout do lease."** Falso (fato 3). Não para.
- **"Fechar pilotos de custo é economia certa e pequena."** É experimento (fatos 6 e 7):
  pequeno em código, médio no calendário, nível Alto, e depende de linha de base.
- **"Tela Nova tarefa" e "núcleo sem Redmine" como esforço médio.** São grandes (fatos 14 e
  15). A fatia de 3 a 5 dias é a fonte de ticket por arquivo com agente real.
- **Ideias que já existem.** Fuga de escopo no checklist do review, mensagem ao agente,
  template de PR, lista de commits no painel Versão. Saíram ou viraram tarefa de horas.
- **"Sessão nova por nó" como lição.** Já é o comportamento atual e é fonte de custo: cerca
  de 32 mil tokens de prefixo por primeira requisição.
- **"Arquivar docs de governança" sem exceção.** `docs/consumer-operations.md` é operacional
  e não se arquiva; dois estudos erraram o fato central por não lê-lo.
- **"Parar telas de design" e "descartar o celular".** O design é baseline aprovado. Ficou
  "tela nova só com dado" e "adiar com data".
- **"Métricas M1–M4 sem registro" como divergência.** A primeira medição só vencia em 16/11.
- **"Adiar discovery" como recomendação.** É decisão do Richard (D2), não achado.
- **Contagens.** 81 a 82 variáveis no `.env.example`, 90 rotas, 33 projetos no Linear.

## 3. Candidatos C01–C35

Valor de 1 a 5. Esforço: P ≤ 3 dias, M 1 a 2 semanas, G > 2 semanas. Fatias conforme os
`FASE.md`. "Fila" = Fase 6, só entra com gatilho.

| ID | Candidato | Tipo | Valor | Esforço | Conf. | Onde entrou |
| -- | -- | -- | -- | -- | -- | -- |
| C01 | Registro de flags com validade | processo / segurança | 5 | P | V | F1.1 |
| C02 | Ponto de retorno do consumidor | segurança | 5 | P–M | V; esforço P | F1.2 |
| C03 | Conferir e fechar exposição | segurança | 5 | P (horas) | H | Antes da Fase 1 |
| C04 | Teto de custo e de turnos por run | segurança / construir | 5 | P + P–M | V; teto em USD na assinatura H | F1.3, F3.4 |
| C05 | Limite de tempo para agente vivo | segurança | 4 | M | V | F3.5 |
| C06 | Reduzir credenciais herdadas pelo agente | segurança | 5 | P–M | V; solução H | F2.6 |
| C07 | Identidade mínima no dashboard | segurança | 4 | M | V | F4.3 (mínimo); fila F6.7 |
| C08 | Fronteira de arquitetura no CI | processo | 3 | P | V | F2.4 |
| C09 | Linha de base de custo | medir | 5 | P + P–M | V (dados existem); conteúdo H | F1.4, F1.5 |
| C10 | Métricas de gate e de tempo humano | medir | 4 | P | V | F3.6 |
| C11 | Prefixo e cache por nó | medir | 3 | P | V; ganho H | Fila F6.1 |
| C12 | Consumo da cota da assinatura | medir | 3 (5 conforme D1) | P–M | H | F3.4 (sonda); fila F6.6 |
| C13 | Antes e depois por flag | medir / processo | 4 | P (regra) + M (coortes) | P | F2.2 (regra), F4.1 |
| C14 | Piloto de esforço por fase (PRI-354) | ligar | 4 | P em código, M no calendário | V; ganho H | F2.3 |
| C15 | Piloto de decomposição | ligar | 4 | P em código, M no calendário | V; ganho H | F2.2 |
| C16 | Cadeia plan+implement | ligar | 3 | P | V; ganho H | Fila F6.4, validade até o fim da Fase 4 |
| C17 | Corrigir o viés `.java` do roteamento | ligar / construir | 4 | M | V | F5.1, F5.2 |
| C18 | Modelo por fase no caminho padrão | construir | 4 | P–M | P | F4.2 |
| C19 | `--follow` no launcher | ligar | 2 | P | V | Fila F6.3 |
| C20 | Portão de build antes do review | construir | 5 | P | V; ganho H | F2.1 |
| C21 | Fila única "Aguardando você" | construir | 5 | M + M–G | V | F4.4, F4.5; fila F6.7 |
| C22 | Notificar todo estado que espera humano | construir | 4 | P | V | F4.6 |
| C23 | Fonte de ticket por arquivo local | construir | 4 | P (3 a 5 dias) | P; fecho do commit H | F3.1 |
| C24 | Projeto-amostra com três tickets de ouro | construir | 5 | M | P; representatividade H | F3.2, F3.3 |
| C25 | Prova de valor contra o agente direto | medir | 4 | M | V (falta); desenho H | F5.4, F5.5 |
| C26 | Gate de verificação manual com evidência | construir | 4 | M | V (peças) | Fila F6.8 |
| C27 | Dossiê de escalation | construir | 3 | P–M | P | Fila F6.9 |
| C28 | Planejamento proporcional à classe | construir | 4 | M | H | Fila F6.2 |
| C29 | Retries, portões e re-review com dado | medir / construir | 3 | P + M | H | F5.3 (análise); fila F6.5 |
| C30 | Ciclo de recusas de QA | construir | 3 | G | V (estado); valor H | Fora; congelado, gatilho na F6.10 |
| C31 | Porta de tracker e de forge | construir | 5 com usuário externo, 2 sem | G | V | Fora; gatilho na F6.11 |
| C32 | Skills por nó e benchmark | construir | 3 | G | H | Fora; gatilho na F6.12 |
| C33 | Poda e extração por fatia | remover / processo | 3 | P | V; branches P | F2.5 |
| C34 | Recorte do Linear e roadmap vivo | processo | 5 | P | V | Antes da Fase 1; rito semanal |
| C35 | Preparação da abertura | abrir | 2 agora, 5 depois de D4 | G | V | Fora; gatilho na F6.11 |

Nenhum item novo entrou depois da consolidação. Os acréscimos são recortes: C07 mínimo, C13
em regra e coortes, C12 como sonda.

**Pré-condições que fixam a ordem.** C01, C02 e C04 antes de qualquer flag ligada no
consumidor. C09 antes de afirmar ganho. C07 antes de decisão nova no dashboard. Um piloto de
custo por vez. A cadeia plan+implement (C16) não convive com o portão de build (C20) sem
ajuste.

## 4. Referências externas

Só o que a revisão de referências confirmou na fonte. Nenhum número abaixo foi medido no
Espectro.

| Fonte | Lição usada | Onde se aplica (leitura do estudo) |
| -- | -- | -- |
| [Referência da CLI do Claude Code](https://code.claude.com/docs/en/cli-reference) | `--max-turns` e `--max-budget-usd` existem em modo `-p`; o gasto pode passar do teto e sessões retomadas não somam | C04 (F1.3, F3.4) |
| [Guia de custo da Claude Platform](https://platform.claude.com/docs/en/about-claude/models/optimizing-for-cost-and-intelligence) | Esforço baixo com reexecução das falhas em esforço alto saiu mais barato em benchmark do fornecedor; exige sinal de falha confiável. Comparar custo por tarefa concluída | C14 (F2.3), C09 |
| [Docs do modo headless](https://code.claude.com/docs/en/headless) | O custo devolvido é estimativa do cliente e pode diferir da fatura | Rótulo "imputado" (F1.4) |
| [METR](https://metr.org/notes/2026-03-10-many-swe-bench-passing-prs-would-not-be-merged-into-main/) | Passar no teste não basta: cerca de metade dos PRs aprovados pelo avaliador não seria mesclada | Review continua pago; C29 |
| [AIDev, arXiv 2601.15195](https://arxiv.org/html/2601.15195) | Falha de CI ou teste pesa na rejeição de PRs de agentes; vale só "CI verde antes do PR" | C20 (F2.1) |
| [Cursor, cloud agents](https://cursor.com/docs/cloud-agent/capabilities.md) | Evidência (screenshot, vídeo, log) anexada ao PR e limite de tentativas de correção de CI | C26 (F6.8) |
| [Changelog do GitHub Copilot](https://github.blog/changelog/2026/04/27/github-copilot-is-moving-to-usage-based-billing/) | Orçamento por uso virou prática de mercado | C04 |
| [arXiv 2601.06007](https://arxiv.org/abs/2601.06007) | Cache de prompt reduz custo; para o Espectro sobra medir o prefixo por nó | C11 (F6.1) |
| [Anthropic, skill-creator](https://claude.com/blog/improving-skill-creator-test-measure-and-refine-agent-skills) | Avaliar skill com braço "sem skill"; texto de anúncio, sem medição independente | C32 (F6.12) |

**Não usar em decisão:**

- **Números do benchmark da Uvik.** Comparam o melhor de quatro braços com o controle, com
  10 tickets por tipo; só um braço fica fora do ruído; a fonte vende o serviço. O estudo
  original ainda omitiu o custo por ticket mesclado. "Planejamento proporcional" fica como
  hipótese (C28).
- **`--bare` enquanto rodar na assinatura.** Exige chave de API e ignora `.claude/commands/`
  e `.claude/agents/`, onde estão os prompts dos nós. Só reabre com D1 = dinheiro.
- **"Meta de 84% de cache."** É mediana observada; o limiar de investigação é cerca de 80%.
- **Cache de 1 hora como alavanca.** A CLI não expõe a duração do cache.
- **Batch para evals de skill.** Batch é da API paga por chave.
- **"Checar duplicidade no fetch do ticket."** O dado vem de repositórios públicos com
  mantenedores externos; não é o caso do Espectro.
- **Alinhar nomes a OTel agora.** A medição já existe; não há demanda.
- **"Dez aprovações por sessão" e "menos gates" como achado.** Opinião de fonte sem dados;
  é a decisão D9.
- **Fontes de marketing como prova** (métricas de agentes, fadiga de aprovação): servem de
  vocabulário, não de evidência.

## 5. Riscos e o que não foi verificado

- **Custo real.** Custo por ticket, taxa de retry, peso de cada fase, número de escalations
  e de recusas de QA são desconhecidos. Todo ganho é hipótese até a F1.5; por isso não há
  percentual prometido.
- **Modelo e esforço padrão da conta.** Desconhecidos. A F2.3 só liga depois de sabê-los.
- **Volume de runs por semana.** Desconhecido. Se for baixo, vale a troca descrita em D6.
- **Exposição.** Ninguém consultou o GitHub nem o compartilhamento do artefato do roadmap de
  arquitetura. As fontes se contradizem sobre o repo ser público (D8).
- **Checkout do consumidor.** No dia do estudo, a pasta apontada como checkout vivo estava
  numa branch de feature. Não se confirmou se é a pasta que o launcher usa.
- **`--max-budget-usd` na assinatura.** Não se sabe se corta. O teto da Fase 1 usa turnos.
- **Nó commit sem Bitbucket.** Não verificado; pode partir a F3.1 em duas.
- **Estimativas sem revisão.** F2.4, F2.6 e a F1.2 se virar pin. F3.5, F4.1 e F4.4 foram
  cortadas para 5 dias a partir de estimativas M.
- **Portão de build.** A premissa foi verificada; o tamanho do ganho, não.
- **Projeto-amostra.** Tickets sintéticos podem não representar o trabalho Java do
  consumidor. Ganho medido nele precisa ser confirmado no consumidor.
- **Linear.** Contagens não recontadas (issues sem nível, criadas × concluídas, "cerca de
  metade é documento"). Comentários e bloqueios não lidos. Risco de duplicar a PRI-327 nas
  fatias F1.4, F1.5 e F3.6.
- **Não verificados e fora do roadmap:** falha do Redmine no meio do tick, limite de uso da
  conta no meio de um nó, proteção do dashboard contra requisição forjada (entra na F4.3),
  24 módulos sem teste par (inclui o caminho que executa SQL aprovado), obrigatoriedade do
  `processo-check`, docs de arquitetura lidos só pelo espelho no Linear.
- **Fontes externas não conferidas.** Parte das referências do estudo original não passou
  pela revisão e ficou fora da tabela acima.
- **Deriva.** Vários números mudaram em horas no dia 15/11. Refaça a leitura antes de usar.
- **Calendário.** 22 cycles sem folga para recesso, incidente ou trabalho do consumidor.
