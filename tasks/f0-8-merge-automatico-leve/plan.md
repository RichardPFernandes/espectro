# Plano F0.8: Merge automático do Leve

Entrada: [`SPEC.md`](SPEC.md), aprovada em 18/11/2026 (D-PRI-410-01). Tarefas em [`todo.md`](todo.md). Nível Alto: um subagente opus por tarefa, um PR só.

## Decisões de implementação

- **Uma função pura de elegibilidade** em `.github/scripts/merge-leve-lib.mjs`, no molde do `processo-lib.mjs`, que ela reaproveita (`matchesAny`, níveis do `processo.json`). O workflow de merge, o resumo diário e o `/pri-pr` chamam a mesma função. Assim, o AC-06 (o `/pri-pr` decide o draft) e o AC-02 (o bot decide o merge) não divergem.
- **A lista mora em `.github/processo.json`, chave `mergeLeve`** (`allowedPaths`, `deniedPaths`, `removableExtensions`, `requiredChecks`). O workflow lê o arquivo do checkout da `main`, e o `/pri-pr` lê `git show origin/main:.github/processo.json`. O PR nunca é a fonte (AC-01).
- **CLI com rede injetável.** `merge-leve.mjs` recebe um `gh` (fetch da API) como parâmetro, e os testes passam um falso que registra as chamadas. É isso que prova o AC-04: sem `MERGE_LEVE=on`, não sai nenhum `PUT .../merge`.
- **Os testes rodam no `processo-check`**, que já executa `node --test .github/scripts/*.test.mjs`. O `npm run test:changed` não cobre `.github/`; durante o build, cada tarefa roda `node --test .github/scripts/*.test.mjs`.
- **Os workflows não fazem checkout do código do PR.** Fazem só o checkout esparso de `/.github/` da `main`, com `persist-credentials: false`. O token com escrita existe só no job que mescla.
- **Os nomes dos checks obrigatórios** (`Node 22`, `Node 24`, `processo-check`) ficam na configuração. Além disso, todo check-run e status do SHA precisa estar `success`, `neutral` ou `skipped`, o que cobre o `Static checks`.

## Ordem e dependências

```
T1 lib + config ──┬── T2 CLI de merge ── T3 workflow de merge
                  ├── T4 resumo diário (CLI + workflow)
                  └── T5 /pri-pr decide o draft
T6 regras e roadmap (texto; depende só da SPEC)
```

Ponto de controle depois de T3: o merge ponta a ponta, em simulação, passa nos testes. Ponto de controle no fim: todos os ACs com teste, e `npm test` e `npm run check` na raiz verdes (o `/pri-check`).

## Riscos

| Risco | Impacto | Mitigação |
| -- | -- | -- |
| `workflow_run` não traz `pull_requests` em alguns eventos (por exemplo, re-run) | Médio: o PR não é avaliado | A CLI também busca o PR pelo `head_sha` (`GET /commits/{sha}/pulls`); se não achar, só registra no resumo do job |
| `Tests` e `processo-check` terminam quase juntos e disparam duas avaliações | Baixo | `concurrency` por PR, e o merge leva `sha`: a segunda chamada recebe 405 ou 409 e é ignorada |
| Push do bot não dispara o `roadmap-pages` | Baixo | `workflow_dispatch` do `roadmap-pages` quando o PR toca `roadmap/` ou `ROADMAP.md` (`actions: write`) |
| A issue fixa do resumo ainda não existe | Baixo | O resumo procura uma issue aberta pelo título exato e a cria na primeira vez |
| O `/pri-pr` fora de draft contraria o passo 8 atual | Médio | T5 troca o passo 8 e o passo 5 juntos; T6 muda a regra 10 no mesmo PR |

## Fora do plano

Gravar `MERGE_LEVE=on`, mudar o ruleset ou ligar "Allow auto-merge": nada disso entra no build. A variável é o AUTORIZO depois do merge do PR (SPEC, item e).
