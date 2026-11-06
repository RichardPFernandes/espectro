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
