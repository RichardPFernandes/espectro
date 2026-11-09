# Evidência: PRI-205 S3b (núcleo 2 do Jev em sombra)

> Estado de cada AC do [SPEC](../../SPEC.md), por fase. Só vale o que foi executado e
> está registrado aqui. O nó Verify do grafo de Runs (`spec-authority.js`,
> `acceptance-evidence.json`) é para tasks do consumidor e não se aplica a uma
> fatia da plataforma; o checklist dele é aplicado à mão.

## Verify da Fase 1 (T1–T3), antes do commit (2026-11-06)

**Execução:** `node --require ./harness/loopback-only.cjs --test scripts/lib/classifier-gray-zone.test.js scripts/lib/classifier-guard.test.js scripts/lib/jev-client.test.js` → 79/79 em Node 22.23.2 e em 24.22.1 (0 fail, 0 skip). Com os testes de `model-routing`, `routing-config` e `dom06-attempt`: 164/164. `lint:src`, `check:js` e `arch:check` limpos (Node 22).

| AC | Estado depois da Fase 1 | Evidência |
| -- | -- | -- |
| AC-03 (zona cinzenta) | **coberto no módulo**; falta a ligação (T6/T7) | `classifier-gray-zone.test.js`: 24 casos de tabela (§4.5, cada exclusão soberana, G1, G2, G3) |
| AC-03b (sonda C1–C3) | **parcial**: elegibilidade coberta; o registro de `would_class`/`DOWN_IGNORED` é da T6/T7 | idem, casos `G3` |
| AC-04 (envelope) | **coberto no cliente**; falta o teste de ponta a ponta (T7) | `jev-client.test.js` › "envia só os três campos…" (o fake confere o corpo recebido) |
| AC-05 (guarda) | **coberto no módulo**; o "fake sem requisição" quando bloqueia é da T6 | `classifier-guard.test.js`: 20 positivos (11 categorias), 8 negativos, fail-closed |
| AC-06 (segredo) | **parcial**: o resultado do cliente nunca contém a chave; a varredura dos arquivos gravados é da T9 | `jev-client.test.js` › "a chave nunca aparece no resultado…" e Keychain sem detalhe |
| AC-09 (não-repetição) | **base**: o cliente classifica timeout/queda depois do envio como `UNCERTAIN`; a regra de não repetir é da T6 | `jev-client.test.js` › timeout e conexão caída |
| AC-10 (401/403) | **base**: `auth_rejected` marcado; a revogação e o desligamento da Run são da T6 | `jev-client.test.js` › HTTP 401/403 |
| AC-01, AC-02, AC-07, AC-08, AC-11 a AC-14 | **não iniciados** (Fases 2 e 3) | — |

**Escopo:** só arquivos novos em `scripts/lib/` (três módulos e três testes), `SPEC.md` e `tasks/pri-205-s3b/`. Nenhum arquivo existente da plataforma foi alterado. Nenhum módulo novo é chamado por código de produção ainda: comportamento de despacho inalterado (dormente).

**Comportamento × spec:** nada mudou de comportamento sem aprovação.
- O SPEC dizia "timeout padrão proposto 3000" e a Q8 fixou 3 s: `DEFAULT_TIMEOUT_MS = 3000`.
- O cliente acrescenta `RESPONSE_TOO_LARGE` (resposta acima de 64 KiB vira `OUT_OF_ENUM`) e `REQUEST_NOT_CREATED`. São refinamentos do B7, sem efeito novo.

**Risco do diff:** médio. Toca integração externa e credencial (Keychain), mas está dormente: nenhum chamador em produção, e nenhuma rede nos testes (loopback). Pelo perfil, a revisão independente G2 (Claude Opus, contexto limpo) fica no Checkpoint C, antes do PR.

**Pendências que o Verify não fecha:** o formato da API TypeSafe não foi verificado contra a documentação oficial (P-3). Não encontrei em `harness/run-tests.js` onde o preload `loopback-only` é ligado no `npm test`; o teste de destino real fica pulado sem ele. A conferir no Checkpoint B.

## T4 (2026-11-06)

`routing-config.test.js` 50/50; conjunto de roteamento e núcleo 2 264/264 em Node 22 e 24; lint, check:js e arch:check limpos. Desvio do plano a favor do SPEC §B2: seção `jev` incompleta e referências malformadas não invalidam a policy nem a config (não bloqueiam a admissão); viram motivo para o núcleo 2 ficar `off` na T5. Parte do AC-07 (forma), sem a admissão ainda.

## T5 (2026-11-06)

AC-07 **coberto** em unidade (`classifier-authority.test.js`, cada linha do B2, `active` → sombra) e no watcher (policy `jev` sem ref → admitida, snapshot com `off`/`AUTHORITY_REF_ABSENT`, despacho igual). Q4: `checkStillAuthorized` testada; a chamada a cada Attempt entra na T6/T7. Snapshot de Run `cheap_rule` idêntico ao da S4 (teste). 313/313 em Node 22 e 24; lint, check:js e arch:check limpos.

## T6 (2026-11-06)

Cobertos no módulo `classifier-shadow.js` (falta só a ligação no watcher, T7): AC-05 (bloqueio sem chamada nem Attempt), AC-08 (intenção durável antes do envio, provada com o cliente real e um fake HTTP), AC-09, AC-10, AC-11 e a parte de gravação do AC-06 (varredura dos arquivos da Run sem a chave). AC-03b: `would_class`/`DOWN_IGNORED` registrados. 13/13; conjunto 326/326 em Node 22 e 24.

## Checkpoint B (2026-11-06)

Receita oficial da suíte `scripts`: Node 22.23.2 1470/0 (6 skip de ambiente); Node 24.22.1 1470/1, a falha é o hook `after` de `routing-off-golden.test.js` (ENOTEMPTY no rmSync do tmp, sob carga), com o teste do golden passando. Sozinho no Node 24: 2/2. Arquivo inalterado desde 4d39a3c. TAPs: `checkpoint-b/nodev22.23.2-scripts.tap` (0d8aff908243…), `nodev24.22.1-scripts.tap` (be3b3fb32bd5…), `node24-routing-off-golden-rerun{1,2}.tap`. Pendência do Checkpoint A fechada: o preload loopback vem por `NODE_OPTIONS` e o teste do destino real rodou na suíte.

## T7 (2026-11-06)

**Cobertos:**
- AC-01: no watcher, `cheap_rule` e Jev sem credencial não criam Attempt `classifier`. A inércia sem ref já vinha da T5.
- AC-02: igualdade da decisão e do argv com e sem núcleo 2, em unidade. No watcher, o argv segue a escolha do núcleo 1.
- AC-04: o envelope sai de `plan-signals.classifierEnvelopes` com só os três campos, e um passo com bloco de código não sai. O cliente já provava o corpo.
- AC-12: os 8 campos e a igualdade entre Attempts.

**Resultado:** 385/385 em Node 22 e 24; `lint:src`, `check:js` e `arch:check` limpos.

## T8 (2026-11-06)

**AC-13 coberto** (`jev-calibration.test.js`, 9/9):
- fake determinístico dá 100%;
- fake alternado dá a taxa esperada;
- `--max-calls` é obrigatório e respeitado;
- repetições `COMPLETE` não se refazem;
- faltantes ficam UNKNOWN (veredito UNKNOWN, nunca PASS).

**Resultado:** 394/394 em Node 22 e 24; `lint:src`, `check:js` e `arch:check` limpos. O U15 real (contra a TypeSafe) não foi executado: depende da ativação (P-4) e do teste de fumaça manual (P-3).

## T10 (2026-11-06)

AC-15, AC-16 e AC-17 cobertos no módulo `classifier-selection.js` (21/21 em Node 22 e 24): opções, as seis validações do §4.8 na ordem com os códigos, auditoria por versão, append-only, concorrência por CAS e trava. A admissão (T11) e a API (T12) ainda não usam o registro.

## T11 (2026-11-06)

**AC-18 coberto:**
- Watcher: a seleção entra no snapshot da Run nova; uma troca posterior não muda a Run admitida (snapshot e hash iguais).
- Unidade: `selection_version` vai para o `classifier_ref`.

Sem registro, o snapshot fica igual ao da S4. Registro quebrado: a Run é admitida e o núcleo 2 fica `off` com o motivo. 422/422 em Node 22 e 24; `lint:src`, `check:js` e `arch:check` limpos.

## T12 (2026-11-06)

**AC-19 coberto** (`dashboard/classifier-selector-api.test.js`, 6/6):
- GET: estado e opções com o código previsto; registro ilegível devolve INVALID, nunca 500.
- POST: aplica, `already_processed` na repetição, recusas 400/409/422 com o código.
- Autoria = usuário local (Q14 revista); `approver` no corpo é ignorado.

**Arquitetura (ARQ-1):** exceção explícita `dashboard/server.js → scripts/lib/classifier-selection.js` na lista de violações conhecidas (77 → 78). A regra AC-02 do CAS é respeitada via `scripts/cas.js` (`isCounter`/`compareCounter`).

Suíte oficial final (`t12-final/`): `dashboard` 307/0 e `scripts` 1519/0 (6 skip de ambiente) em Node 22.23.2 e 24.22.1; lint, check:js e arch:check limpos.

## Checkpoint C (2026-11-08)

### Revisão independente G2

Revisor Claude Opus em contexto limpo (subagente `agent-skills:code-reviewer`), sem Codex, sobre `4d39a3c..c372e92`. **Veredito: CHANGES_REQUESTED.** Ele rodou 224/224 + 107/107 testes focados e 6/6 do dashboard (Node 22).

| Achado | Severidade | Disposição |
| -- | -- | -- |
| 1. A chave de visita da EffectId mudava entre ticks antes do `node_start` (pré-build falho, churn, admissão sem despacho, reinício), então um pedido UNCERTAIN podia ser reenviado | MAJOR | **Corrigido.** `routing-run.nucleus2VisitKey`: a visita é o fim da visita anterior (último evento de ciclo de vida de outro nó), estável antes do `node_start` e nos retries. Sem eventos, a chave é constante (conservador). `nodeVisitStart` não muda. Testes: `routing-run.test.js` › "nucleus2VisitKey…" e `classifier-shadow.test.js` › "achado MAJOR 1…" (UNCERTAIN + novo tick → 0 requisições). |
| 2. POST `async` relançava erro inesperado e podia derrubar o Dashboard | MINOR | **Corrigido.** Handler síncrono: o Express 4 converte `throw` em 500. |
| 3. Corrida na retomada da trava abandonada | MINOR | **Corrigido.** A retomada passou a ser `rename` atômico para um nome único, e só quem renomeia segue. Teste de regressão da trava abandonada. |
| 4. U15 reenviava com outro `--out` ou em execuções simultâneas | MINOR | **Corrigido em parte.** Uma trava por `--out` (a segunda execução recebe `BUSY`, código 2). O doc manda usar sempre o mesmo `--out`. **Resíduo:** com outro `--out` de propósito, a não repetição não alcança o diretório anterior. |
| 5. O filtro de código só pegava cercas e não olhava os ACs; ids do Redmine passavam | MINOR (PLAUSIBLE) | **Corrigido em parte.** Linha com cara de código (fim `;{}` ou palavra-chave) no passo, e verificação também nos ACs (`AC_HAS_CODE_BLOCK`). O texto chega normalizado pelo `plan-scorer`, então a margem não é detectável. **Resíduo para decisão do Richard:** ids do Redmine (`#123`) no texto do passo. |
| 6a. `--synthetic` envia com "Só policy" | NIT | Intencional (P-3); documentado no doc e no handoff. Exige Authority Ref e credencial. |
| 6b. O teste de watcher chama o `/usr/bin/security` real, com item inexistente | NIT | **Mantido.** O watcher roda em subprocesso, sem ponto de injeção. Nenhum segredo é lido, porque o item não existe. |
| 6c. `envelope_reason: ENVELOPE_MISSING` gravado mesmo com envelope | NIT | **Corrigido.** |
| 6d. Mudança de prompt deixa a seleção desatualizada | NIT | **Documentado** em `docs/classifier-nucleus2.md` (falhas): fica `off` até salvar de novo. |
| 6e. `readSelection` não conferia escolha × provider | NIT | **Corrigido** (`choice_mismatch`) e testado. |
| 6f. `valid_until` não é relido por Attempt | NIT | Conforme o B2 (só a revogação é relida). Sem mudança. |

### Suíte oficial depois das correções (`checkpoint-c/`)

- **Node 22.23.2:** `dashboard` 307/0; `scripts` 1527/0 (6 skip de ambiente).
- **Node 24.22.1:** `dashboard` 307/0; `scripts` 1527 pass e 1 fail. A falha é a mesma corrida preexistente do checkpoint B: o hook `after` de `routing-off-golden.test.js` dá `ENOTEMPTY` no `rmSync` do tmp, enquanto o teste do golden (AC-01 da S4) passa. Sozinho no Node 24, o arquivo passa 1/1. O arquivo não mudou desde a base. Fica como follow-up fora da fatia.
- `lint:src`, `check:js` (dos dois pacotes) e `arch:check` limpos.

### Verify por AC (SPEC)

| AC | Estado | Evidência |
| -- | -- | -- |
| AC-01 inércia | AUTOMATIZADO | watcher: `cheap_rule` e Jev sem credencial não criam Attempt `classifier`; T5: sem ref → `off`; golden do `mode` OFF |
| AC-02 sem efeito no despacho | AUTOMATIZADO | `model-routing.test.js` › "S3b AC-02" (decisão e argv iguais com C1/0,99); watcher: argv = escolha do núcleo 1 |
| AC-03 zona cinzenta | AUTOMATIZADO | `classifier-gray-zone.test.js` (24 casos) |
| AC-03b sonda C1–C3 | AUTOMATIZADO | gray-zone G3; `classifier-shadow` (`would_class`, `DOWN_IGNORED`); `model-routing` B8 |
| AC-04 envelope | AUTOMATIZADO | `jev-client` (corpo recebido pelo fake); `plan-signals.classifierEnvelopes` (3 campos, código bloqueado no passo e no AC) |
| AC-05 guarda | AUTOMATIZADO | `classifier-guard.test.js` (11 categorias); `classifier-shadow` (bloqueio sem chamada nem Attempt) |
| AC-06 segredo | AUTOMATIZADO | `jev-client` (chave fora do resultado); `classifier-shadow` › Q6 (varredura dos arquivos gravados); API (senha/chave fora das respostas) |
| AC-07 admissão | AUTOMATIZADO | `classifier-authority.test.js` (cada linha do B2); watcher › "S3b T5 / AC-07" |
| AC-08 registro antes do envio | AUTOMATIZADO | `classifier-shadow` › AC-08 (cliente real + fake HTTP vê o Attempt STARTED) |
| AC-09 não repetição | AUTOMATIZADO | `classifier-shadow` › AC-09 e "achado MAJOR 1"; `routing-run` › `nucleus2VisitKey` |
| AC-10 401/403 | AUTOMATIZADO | `classifier-shadow` › AC-10 |
| AC-11 nó não bloqueia | AUTOMATIZADO | `classifier-shadow` › AC-11 (Attempt do Implement byte a byte igual) e T9 (retry se liga ao Implement) |
| AC-12 `classifier_ref` | AUTOMATIZADO | `model-routing` › AC-12 (8 campos, iguais entre Attempts, alias → UNKNOWN, `selection_version`) |
| AC-13 U15 | AUTOMATIZADO com fake | `jev-calibration.test.js` (determinístico, alternado, teto, retomada, UNCERTAIN, BUSY). **U15 real não executado** (depende da ativação, P-3/P-4) |
| AC-14 suíte | AUTOMATIZADO | suíte oficial acima (com a ressalva do flake preexistente no Node 24) |
| AC-15 opções do seletor | AUTOMATIZADO | `classifier-selection.test.js` |
| AC-16 writer 0–5 | AUTOMATIZADO | `classifier-selection.test.js` (cada código, na ordem) |
| AC-17 auditoria e atomicidade | AUTOMATIZADO | `classifier-selection.test.js` (append-only, CAS via `cas.js`, trava, trava abandonada) |
| AC-18 só Runs novas | AUTOMATIZADO | watcher › "S3b T11 / AC-18" |
| AC-19 API | AUTOMATIZADO | `dashboard/classifier-selector-api.test.js` (6) |

**Validação humana pendente:**
- teste de fumaça real (P-3);
- ativação (Authority Ref, Keychain, seleção);
- U15 real;
- formato real da API TypeSafe (lido no plugin thinkdial).

**Para a reconciliação (regra 8, NOT APPLIED):**
- RC-6;
- sonda C1–C3, que amplia o §4.8;
- ARQ-1 (exceção 77 → 78);
- abertura do seletor antes da S7d;
- Q14 revista (sem aprovador).
