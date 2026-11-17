---
id: integracoes
tipo: capacidade
resumo: Fala com o Redmine e o Bitbucket e avisa o dev por webhook, cobrindo ticket, anexos, PRs, horas e notificações.
situacao: ligada
spec: sem-spec
flags: [NOTIFY_WEBHOOK_URL]
modulos:
  - scripts/lib/redmine-*
  - scripts/lib/attachment-downloader.js
  - scripts/retry.js
  - scripts/lib/bitbucket-pr.js
  - scripts/bitbucket-open-pr.sh
  - scripts/check-pr-status.js
  - scripts/lib/pr-status-poll.js
  - scripts/lib/pr-conflicts.js
  - scripts/notify.js
  - scripts/lib/cycle-notifications.js
  - scripts/redmine-hours.js
  - scripts/backfill-redmine-hours.js
  - scripts/sync-redmine-hours-live.js
---

# Integrações
O Redmine é a origem do ticket: `redmine-fetch.js` busca com retry, o `attachment-downloader.js`
baixa e converte os anexos para o nó de plano, e o `redmine-journal-fetcher.js` lê a nota de
recusa de QA e troca o status. O Bitbucket recebe o PR (`bitbucket-open-pr.sh`) e é consultado
depois: estado do PR, conflito de merge e consistência entre repositórios. As horas de cada Run
sobem ao Redmine com o marcador `[prisma-hours:<task>]`, sem duplicar.

Sem `NOTIFY_WEBHOOK_URL`, a notificação não faz nada. Com ela, o dev recebe o PR aberto, o PR
draft de risco alto e a escalação.

## Por onde começar

1. [`scripts/lib/redmine-fetch.js`](../../scripts/lib/redmine-fetch.js): o cliente do Redmine e o que conta como erro transitório.
2. [`scripts/lib/pr-status-poll.js`](../../scripts/lib/pr-status-poll.js): o acompanhamento dos PRs depois de abertos.
3. [`scripts/lib/cycle-notifications.js`](../../scripts/lib/cycle-notifications.js): quando o watcher notifica.
4. [`scripts/notify.js`](../../scripts/notify.js): o envio e as garantias de nunca derrubar o ciclo.
5. [`scripts/lib/redmine-hours-sync.js`](../../scripts/lib/redmine-hours-sync.js): da duração da Run às horas do Redmine.
