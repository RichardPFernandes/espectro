# SDD: PRI-315, Plan com `permissions.deny` em vez de `--disallowedTools`

> **Status:** v0.3. Spec aceita e implementação autorizada pelo Richard em 13/11/2026
> ("Aceito e AUTORIZO"), com as recomendações D1–D4. Ligar a flag em qualquer ambiente e o
> piloto no watcher continuam fora e pedem AUTORIZO próprio. **Resultado:** na 2.1.323 a
> premissa não se confirma (ver «Resultado» no fim e `evidence/README.md`).
>
> Issue: [PRI-315](https://linear.app/prisma-app/issue/PRI-315) (L1 da PRI-206 @ v74). Milestone
> "Eficiência de execução do ciclo". `roadmap-ref: sem card`. Código lido em `main` `5560d29`,
> Claude Code local 2.1.323. A evidência da PRI-206 foi colhida na 2.1.319.

## Nível de processo

A issue não tem rótulo `Processo`. **Proposta: Médio para esta fatia.** A fatia muda o argv do
despacho atrás de uma flag desligada e não toca em estado autoritativo, autorização humana ou
segurança. Todo o resto é **Alto** e pede AUTORIZO específico: ligar a flag no consumidor,
fazer o piloto com runs pareadas (AC4) e qualquer mexida no arquivo `--settings` da prova do
plugin (SP-2). Vale a regra de que, na dúvida, sobe-se o nível. Se o Richard preferir Alto para
tudo, a fatia ganha a revisão G3 e o resto continua igual.

## Contexto (AS-IS)

`dispatchClaudeSegment` (`scripts/readmine-watcher.js:4277`) monta o argv do `claude -p`. Quando
algum nó do segmento está em `NO_SUBAGENT_NODES` (`{'plan'}`, linha 4270), ele acrescenta
`--disallowedTools Agent,Task` (linha 4313). Com isso, Agent e Task saem da lista de
ferramentas, que é o 1º segmento do prompt. O prefixo do plan deixa de ser igual ao dos outros
nós, e o 1º request do plan grava o prefixo inteiro no cache sem ler nada (PRI-206 P0: read 0,
write 46.896).

Em run roteada (PRI-233 T7), `modelRouting.routedArgs` (`scripts/lib/model-routing.js:359`)
acrescenta `--settings <plugin_proof.settings_path>`. Esse é o arquivo da prova SP-2, que tem
sha256 registrado na RoutingDecision.

Mais dois pontos usam a mesma forma e ficam **fora** desta fatia: o pre-build-ai-fix
(`scripts/lib/pre-build-ai-fix.test.js:65`) e o golden do plan-scorer, que só confere o AS-IS.

## Objetivo

Com a flag ligada, o nó plan continua **sem conseguir** abrir subagente, mas mantém a lista de
ferramentas igual à dos outros nós. Assim o 1º request lê o prefixo do cache em vez de
regravá-lo. Com a flag desligada, nada muda, byte a byte.

## Desenho

1. **Flag**: `WATCHER_PLAN_DENY_SETTINGS`, que liga com `1|true|sim` (mesma convenção de
   `WATCHER_QA_DIAGNOSTICO`, linha 393) e vem desligada por padrão.
2. **Função pura** `subagentBlockArgs({ nodes, routed, flag })`, extraída do despacho, que
   devolve o trecho de argv:
   - nenhum nó em `NO_SUBAGENT_NODES` → `[]`;
   - flag desligada → `['--disallowedTools', 'Agent,Task']` (AS-IS);
   - flag ligada e despacho **não** roteado →
     `['--settings', '{"permissions":{"deny":["Agent","Task"]}}']`. É JSON inline, então não
     grava arquivo nem cria estado;
   - flag ligada e despacho **roteado** → AS-IS (`--disallowedTools`). Ver a decisão D1.
3. A posição no argv é a mesma de hoje, logo depois de `--allowedTools`. `--allowedTools`
   continua como está. No Claude Code, uma regra de deny vence uma de allow, e a prova (AC1)
   confirma isso.
4. Comandos (`.claude/commands/*`), prompt do despacho, outros nós e MCP: sem mudança.

## Medição (foco desta issue)

Ferramenta offline `scripts/probes/plan-cache-probe.js`. Roda com a config pessoal, num
diretório scratch, sem Redmine, sem consumidor e sem `state.json`. Ela monta o argv **com a
mesma função** do watcher e lê o transcript de cada sessão.

- **Braços:** A = AS-IS (`--disallowedTools`) e B = flag ligada (`permissions.deny`).
- **Sequência por amostra:** 1 sessão de aquecimento com o argv base (o de um nó sem bloqueio,
  como o review), depois a sessão do plan, dentro do TTL do cache. Os braços alternam A/B para
  não favorecer nenhum lado.
- **Por sessão do plan:** `cache_read_input_tokens`, `cache_creation_input_tokens` e
  `input_tokens` do **1º request**, mais o total de tokens da sessão (in, out, read, write)
  e o custo estimado pela tabela já usada em `cost-analyze-transcripts.py`.
- **Saída:** JSON e Markdown com `n`, mediana, mínimo e máximo por braço, a versão do Claude
  Code e o commit.
- **Limite honesto:** offline, o prompt do plan é um stub curto. Mede bem o prefixo (1º
  request), mas **não** mede os tokens de uma run real do nó plan. Isso só sai do piloto no
  watcher (AC4), que é Alto. Até lá, o valor no watcher e no consumidor fica **UNKNOWN**, não
  zero.

## Critérios de aceitação → verificação

| AC | Verificação | Onde |
| -- | -- | -- |
| AC1. Com a flag ligada, Agent/Task no plan é recusado | Probe com um prompt que manda chamar Agent e Task. Passa se houver `tool_use` com `tool_result` de erro de permissão e nenhum transcript de sidechain/subagente. n ≥ 3 | `plan-cache-probe.js prove-deny` |
| AC2. Read do 1º request > 0 com a flag ligada, com `n` | Probe, braço B, n = 5 (proposto). Registrar mediana e faixa, junto com o braço A | `plan-cache-probe.js` |
| AC3. Flag desligada = argv byte-idêntico ao AS-IS | Teste unitário da função pura (os 4 casos) e um golden do argv completo do plan com a flag desligada | `scripts/lib/subagent-block.test.js` (novo) |
| AC4. Não regressão (PRI-269) | Suíte do harness verde (`harness/run-tests.js`), dry-run do plan com a flag ligada e desligada, e **runs pareadas no watcher** | Suíte e dry-run nesta fatia. Runs pareadas: N e tolerâncias do Richard, piloto com AUTORIZO |

## Comandos

```
node harness/run-tests.js                                # suíte oficial (skill prisma-tests)
node --test scripts/lib/subagent-block.test.js           # AC3
node scripts/probes/plan-cache-probe.js measure --n 5 --out tasks/pri-315/evidence/      # AC2 (gasta tokens)
node scripts/probes/plan-cache-probe.js prove-deny --n 3 --out tasks/pri-315/evidence/   # AC1
node scripts/probes/plan-cache-probe.js tool-list --out tasks/pri-315/evidence/            # 1º segmento do prompt
```

## Arquivos

- `scripts/readmine-watcher.js`: troca a linha 4313 pela chamada à função e lê a flag.
- `scripts/lib/subagent-block.js` (novo) e `.test.js` (novo).
- `scripts/probes/plan-cache-probe.js` (novo).
- `tasks/pri-315/evidence/` com as saídas do probe, sem dados do consumidor.

## Limites

- **Sempre:** flag desligada por padrão, golden do AS-IS, PR em draft, evidência com versão do
  Claude Code e commit.
- **Perguntar antes:** gastar tokens no probe; ligar a flag em qualquer ambiente; piloto no
  watcher; mexer no arquivo de settings da SP-2.
- **Nunca:** mudar o texto dos comandos (PRI-300) ou o conjunto de MCP (PRI-316); estender ao
  pre-build-ai-fix ou a outros nós nesta fatia; usar dado do consumidor na evidência.

## Critério de reversão (da issue)

Desligar a flag se o read do 1º request não subir, se o custo por sessão do plan subir, se o
plan conseguir abrir subagente ou se algum artefato ou veredito divergir.

## Decisões em aberto

- **D1. Run roteada + flag ligada.** O `routedArgs` já passa um `--settings` (o arquivo da
  SP-2), e não está provado como o CLI trata dois `--settings`. Opções:
  (a) **recomendada:** em run roteada, mantém o AS-IS. Não há ganho nela, mas também não há
  risco para a SP-2;
  (b) juntar o deny no arquivo da SP-2. Isso muda um artefato com sha256 provado e passa a ser
  Alto;
  (c) passar dois `--settings`. Antes, precisaria de uma prova de merge na versão do CLI.
- **D2. `n` do probe offline:** 5 por braço (proposto) para o AC2 e 3 para o AC1.
- **D3. N e tolerâncias das runs pareadas do AC4** (a issue reserva isso ao Richard), e se o
  piloto entra nesta issue ou numa fatia Alto separada.
- **D4. Nível:** Médio para a fatia, Alto para ligar a flag e para o piloto. Pôr o rótulo
  `Processo` na issue.

## Riscos

- Com o deny, Agent continua visível na lista de ferramentas. O modelo pode tentar chamá-lo,
  levar a recusa e gastar um turno. O "custo por sessão" do critério de reversão cobre isso, e
  o probe registra quantas recusas ocorreram.
- A semântica do deny pode mudar entre versões (2.1.319 → 2.1.323). Por isso o AC1 roda na
  versão atual e a registra.
- Um `--settings` do consumidor pode conflitar com o JSON inline. Hoje o watcher só passa
  `--settings` na rota roteada, que a D1(a) deixa no AS-IS.

## Resultado (13/11/2026, Claude Code 2.1.323)

- A lista de ferramentas do evento `init` sai **igual** no plan com `permissions.deny` e no
  plan com `--disallowedTools`, e as duas diferem da do review, onde aparece `Task`. Nesta
  versão, o deny com o nome puro tira a ferramenta da lista. O prefixo não passa a ser
  compartilhado, e vale o critério de reversão "o read do 1º request não sobe".
- Nesta versão a ferramenta de subagente se chama `Task`. O review não tem `Agent` na lista, e
  por isso o deny de "Agent" não tem efeito.
- A tabela A/B não discrimina os braços: com listas iguais, as sessões dos dois braços leem o
  cache umas das outras (TTL de 1 h). A conclusão vem do `tool-list`, que tem n=1 por argv.
- AC1 (indisponível): `has_task: false` no plan com a flag (`tool-list`). O `prove-deny` deu
  INCONCLUSIVE (3×, sem tentativa), porque a ferramenta nem chega a ser oferecida.
- O read de 27.165 da PRI-206 P0b (2.1.319) fica UNKNOWN: pode ser o mesmo viés de reuso do
  cache ou uma mudança de semântica entre as versões.
