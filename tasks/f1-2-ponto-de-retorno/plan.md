# Plano F1.2: ponto de retorno do consumidor

SPEC: [`SPEC.md`](SPEC.md), aprovada em 17/11/2026 (`D-PRI-379-01`). Tarefas: [`todo.md`](todo.md).
Nível Alto. Código lido em `main` `8aaaa91`.

## Visão geral

Um módulo `scripts/lib/return-point.js` concentra a conferência da árvore, a marca (tag
`verde/*`), a checagem de saúde e a volta. A CLI `scripts/return-point.js` só chama o
módulo. O dashboard (subida) e o watcher-manager (tick) chamam a conferência quando
`PRISMA_CHECKOUT_GUARD=1`. Tudo é testado em repositórios temporários com uma origem
local (`git init --bare`), sem rede e sem o checkout vivo.

## Decisões de arquitetura

- **Um módulo, dependências injetáveis.** `git`, `fetch` HTTP, `lockStatus` e relógio entram
  por parâmetro, como já se faz em `dashboard/version.js`. Os testes não sobem dashboard real.
- **"Na `main`" = HEAD alcançável por `refs/remotes/origin/main` local** (`git merge-base
  --is-ancestor HEAD origin/main`). Sem `fetch`: a conferência não depende de rede e não
  mexe em refs.
- **Sujeira = `git status --porcelain --untracked-files=normal` não vazio.** Arquivo ignorado
  não conta. O `pnpm-lock.yaml` solto vai para o `.gitignore` (o repo usa npm), na T6.
- **Tag `verde/AAAAMMDD-HHMMSS` em UTC, anotada, com o JSON do resultado na mensagem.**
  "Último verde" = a tag `verde/*` de data mais recente (`git for-each-ref --sort=-creatordate`).
  Nada apaga nem move tag; colisão de nome no mesmo segundo é erro, não sobrescrita.
- **`back` = `git switch --detach <tag>`**, depois de recusar árvore suja, trava `held`,
  agente vivo ou watcher rodando (lido de `/api/watcher/status` quando o dashboard
  responde; sem resposta, só a trava). Aviso, sem recusa, quando `scripts/package-lock.json`
  ou `dashboard/package-lock.json` diferem entre o HEAD e a tag.
- **Guard no tick:** em `spawnTick` (`scripts/watcher-manager.js:197`), antes do `spawn`. Recusa
  para o laço com `error: 'checkout_guard'` e o motivo em `status().guard`. Na subida: no bloco
  `require.main` de `dashboard/server.js`, antes do `listen`, com `process.exit(2)`.
- **Flag ausente = zero comando novo.** A leitura da flag fica num só lugar
  (`guardEnabled(env)`), e o teste da AC-06 conta as chamadas a `git` com a flag ausente.
- **Log:** `logs/return-point.jsonl` na raiz dada, já ignorado pelo `.gitignore`
  (`**/logs/**/*.jsonl`). Só SHA, tag, hora, itens e resultado. Nada de caminho absoluto.

## Ordem e dependências

```
PRI-372 (PR A, Médio, branch própria)      T1 conferência da árvore
                                              ├── T2 marca e log ── T3 checagem de saúde
                                              │                         └── T4 back + CLI ── T7 ensaio
                                              └── T5 guard (dashboard + tick)
                                           T6 docs, flag, dono, .gitignore (depois de T1–T5)
```

T0 (PRI-372) é independente e vai antes, em PR próprio. T1 é a base. T5 só depende de T1.

## PRs

- **PR A, PRI-372 (Médio):** branch `RichardPFernandes/pri-372-log-conflitos` a partir da
  `origin/main`, numa worktree própria. Uma revisão G3. Refs PRI-372.
- **PR B, F1.2 (Alto):** esta branch, T1 a T7. Rodada G3 com dois revisores, pedido do
  `/pri-autorizo` com Rollback e Readback, Refs PRI-379. A Evidência cita o PR A (AC-05).

## Riscos

| Risco | Impacto | Mitigação |
| -- | -- | -- |
| A PRI-393 (worktree `testes`, T6 dela) também mexe em `STATE_CONFLICTS_LOG` no harness | Médio | O PR A corrige no teste e no `cas.js`, sem tocar o `harness/`; quem mesclar depois resolve conflito trivial |
| Teste de git lento ou com config global do usuário (assinatura, hooks) | Médio | Repositórios temporários com `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1` e autor fixo |
| Guard recusar no dia de ligar por arquivo solto no checkout vivo | Alto | O `status` da CLI lista a sujeira antes; o readback do `/pri-autorizo` roda `status` primeiro |
| `server.js` tem 3.900 linhas; o guard de subida mexe no bloco de boot | Baixo | Mudança de poucas linhas; teste roda o servidor como processo filho com a flag ligada e árvore suja |

## Fora deste plano

Tudo que a SPEC lista em "Não inclui". Em especial: nenhum comando no checkout vivo; o
ensaio real, a primeira tag e ligar a flag são do Richard, com AUTORIZO.
