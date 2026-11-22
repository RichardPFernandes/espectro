---
id: ciclo-da-run
tipo: fluxo
resumo: O watcher, que a cada tick descobre os tickets, aplica os portões e despacha o próximo nó.
situacao: ligada
spec: sem-spec
flags: [DRY_RUN, DISABLE_AUTO_CLEANUP, WORKTREE_CLEANUP_ON_PR_OPEN, PRISMA_CHECKOUT_GUARD]
adrs: [ADR-0001]
modulos:
  - scripts/readmine-watcher.js
  - scripts/watcher-manager.js
  - scripts/replay-cycle.js
  - scripts/lib/cycle-replayer.js
  - scripts/lib/dispatch-reservation.js
  - scripts/lib/dry-run.js
  - scripts/lib/graceful-shutdown.js
  - scripts/lib/node-events.js
  - scripts/lib/process-identity.js
  - scripts/lib/return-point.js
  - scripts/lib/watcher-health.js
  - scripts/lib/watcher-lock.js
  - scripts/lib/worktree-cleanup.js
---

# Ciclo da Run

O `readmine-watcher.js` roda um tick e sai. A cada tick fecha as métricas pendentes, busca os
tickets do Redmine, reidrata os que já têm Run local e, por ticket, aplica os portões e despacha
o próximo nó (`dispatchTicket`). Uma trava de instância mantém um watcher por `REPO_PATH`; uma
reserva por ticket impede que o watcher e o dashboard despachem o mesmo ticket juntos. O
`watcher-manager.js` é o laço que o dashboard usa para repetir o tick.

Cada nó executado deixa eventos em `state.json`; o replay reentra o ciclo num nó anterior, numa
Run nova. Com `DRY_RUN=true` o ciclo roda contra fixtures, sem chamada externa. Worktrees saem quando o PR abre, salvo `WORKTREE_CLEANUP_ON_PR_OPEN=0`.

## Por onde começar

1. [`scripts/readmine-watcher.js`](../../scripts/readmine-watcher.js): `tick`, `dispatchTicket` e os portões; tem mais de 6.000 linhas.
2. [`scripts/watcher-manager.js`](../../scripts/watcher-manager.js): o laço de ticks e o limite de reinícios por hora.
3. [`scripts/lib/dispatch-reservation.js`](../../scripts/lib/dispatch-reservation.js): a reserva por ticket, entre processos.
4. [`docs/runbook.md`](../runbook.md): como operar o watcher no dia a dia.

<!-- ligacoes:inicio -->
## Ligações

- ADRs: [ADR-0001](../adr/0001-checkout-com-ponto-de-retorno.md) — O consumidor roda de checkout, com ponto de retorno; não volta ao pin
<!-- ligacoes:fim -->
