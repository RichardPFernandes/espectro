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
