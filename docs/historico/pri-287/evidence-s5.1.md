# Evidência — PRI-310 (PRI-287 S5.1): contrato do DOM-06 e manifesto do workspace

SDD: `tasks/pri-287-s5/SPEC.md` v2.1 (aprovada pelo Richard em 2026-11-09; Q1–Q7 decididas, Q3 corrigida).
Escopo da S5.1: B1, B3, B4; AC-01 a AC-21 e AC-35. RC-1 a RC-6 e RRC-F31-001/002 seguem **NOT APPLIED**.
A flag `decomposition: "on"` segue **reservada** (fail-closed); nenhuma Run real nasce decomposta.

## Verificação por AC

| AC | Onde | Resultado |
| -- | -- | -- |
| AC-01 golden Run ON pré-decomposição | `scripts/lib/routing-on-golden.test.js` + `scripts/fixtures/routing-on-golden.json` (gerado em `2024597`, commit `6efa462` antes de qualquer mudança); variante OFF+`decomposition:on` em `routing-off-golden.test.js` | PASS antes e depois das mudanças |
| AC-02 OFF ignora a chave (aviso); ON + valor inválido bloqueia | `dom06-decomposition.test.js` | PASS |
| AC-03 `on` → `DECOMPOSITION_RESERVED`; `off` = bytes iguais | `dom06-decomposition.test.js` | PASS |
| AC-04 identidade, SUPERSEDED, sem Arquivo, intercalados | `subtask-decomposition.js` + `dom06-decomposition.test.js` | PASS (ver divergências) |
| AC-05 tabela de aceite; obrigação só com aceite | `dom06-decomposition.test.js` | PASS |
| AC-06 agregação (por visita) e idempotência | `dom06-decomposition.test.js` (incl. C-A-01, C-O-04) | PASS |
| AC-07 `latestBound` com intercalação | `dom06-decomposition.test.js` | PASS |
| AC-08 resultado tardio | `dom06-decomposition.test.js` | PASS |
| AC-09 saída única nos dois caminhos; motivo do release | `dom06-decomposition.test.js` | PASS no caso fail-closed da S5.1 (ver pendências) |
| AC-10 órfão UNCERTAIN | `dom06-decomposition.test.js` | PASS |
| AC-11 sem `escalation` | `dom06-decomposition.test.js` + suíte da S4 | PASS |
| AC-12…AC-17 M1–M6 | `workspace-manifest.test.js` | PASS |
| AC-18 M7 sem exportar conteúdo; chave fora do worktree | `workspace-manifest.test.js` | PASS |
| AC-19 M8 encadeamento e reancoragens | `workspace-manifest.test.js` + `dom06-decomposition.test.js` | PASS |
| AC-20 M9 retry, teto, mutação | `workspace-manifest.test.js` + `dom06-decomposition.test.js` | PASS na parte do DOM-06 (ver pendências) |
| AC-21 UNKNOWN extras | `workspace-manifest.test.js` | PASS |
| AC-35 suítes Node 22 e 24 | ver "Suítes" | ver abaixo |

## Suítes (receita oficial, `harness/run-tests.js`, HOME/TMPDIR sintéticos, loopback-only)

Execução final sobre o código deste PR (worktree limpo de mudanças alheias), 2026-11-09:

| Pacote | Node 22.23.2 | Node 24.22.1 |
| -- | -- | -- |
| `scripts/` | 1850 testes, 1842 pass, 2 fail | 1850 testes, 1842 pass, 2 fail |
| `dashboard/` | 394/394 pass | 394/394 pass |

As 2 falhas de `scripts/` são o mesmo teste (`qa-rejection-c0-oracle`, "árvore adversarial… symlink real", nas duas listas em que roda): o TMPDIR sintético em `/var/folders` é resolvido pelo macOS para `/private/var` e o teste compara o caminho literal. O teste não importa nenhum módulo alterado; com TMPDIR já resolvido, 23/23 passam. Falha de ambiente, preexistente, sem relação com o diff (UNKNOWN em CI Linux não verificado aqui).

Também executados: `npm run check:js` (exit 0), `npm run lint:src` (exit 0), `npm run arch:check` em Node 22 (exit 0), e os testes novos isolados (dom06-decomposition 23/23, workspace-manifest 21/21, routing-on-golden 1/1, routing-off-golden 1/1).

## Revisão G3 do código (Opus + Arquiteto, contexto limpo, só leitura)

| Rodada | Opus | Arquiteto |
| -- | -- | -- |
| r1 | CHANGES_REQUESTED (C-O-01…12; MAJOR: locale no digest, teto do AC-20) | CHANGES_REQUESTED (C-A-01…12; MAJOR: agregação velha na 2ª visita, teto do AC-20) |
| r2 | APPROVED_WITH_CHANGES (R2-C-O-01/02 MINOR, R2-C-O-03 NIT — corrigidos) | APPROVED |

## Divergências declaradas em relação à SDD

- Identidade de conteúdo calculada em processo (SHA-256 dos bytes), equivalente a `git hash-object --no-filters`, sem gravar objeto e sem rodar filtros/drivers; mais conservadora.
- Diretórios vazios não observados (o git não os versiona); repositório aninhado → `NESTED_REPOSITORY` (UNKNOWN).
- Índice como uma entrada agregada (digest do `ls-files -s -v`, com flags); caminhos assume-unchanged e skip-worktree (existentes) entram em `tracked`.
- AC-04 como módulo puro `subtask-decomposition.js` (sem tocar `plan-signals.js`, que outra sessão editava no checkout principal); gravação em `state.json` e `initial_class` ficam na S5.2 (B2).
- `releaseLease` do watcher também mudou (plumbing exigida por B3; a lista de arquivos da SDD para a S5.1 o omitia).
- AC-15 com 2 500 arquivos e limite 50 (equivalente aos 50 000 da SDD).
- Ordinal `seq` monotônico por Run nos Attempts com papel (ordem integração × rework sem depender de `created_at`).
- Limite declarado: filtros clean do consumidor (ex.: git-lfs) podem rodar no `git status` para arquivos "racy".

## Pendências declaradas para a S5.2 (PRI-311)

- C-O-07/C-A-04: os dois caminhos de saída ainda não passam `manifestPost` nem `currentPlanVersion` (o JSON do lease não leva o diretório de manifestos). Hoje todo Attempt com papel fecha `PLAN_VERSION_UNKNOWN` (fail-closed). O aceite gravado é definitivo.
- AC-20 parte do watcher: `looksUnavailable` fora do teto e precedência de `session_limit` (até lá, indisponibilidade também consome o teto).
- C-A-09: seções `manifest_limits` e `workspace_watch_globs` na policy (exigem nova versão aprovada); hoje `observe()` recebe por parâmetro.
- C-A-10: `closeOrphan` ligado a `recoverOrphans`; `destroyKey` no arquivamento; retenção dos manifestos em `_dom06-manifests`.
- `seq` por varredura: único enquanto não houver paralelismo (S5 é sequencial).
- Falhas ambientais conhecidas (não relacionadas ao diff): `qa-rejection-c0-oracle` com TMPDIR em `/var` (macOS resolve para `/private/var`; 23/23 com TMPDIR resolvido); `architecture-boundaries` exige Node ≥ 22 (dependency-cruiser).
