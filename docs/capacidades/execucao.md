---
id: execucao
tipo: capacidade
resumo: Monta o contexto e a linha de comando do agente de cada nó e lê os sinais de saída dele.
situacao: ligada
spec: sem-spec
flags: [WATCHER_PLAN_IMPLEMENT_CHAIN, WATCHER_PLAN_DENY_SETTINGS]
modulos:
  - scripts/lib/node-dispatcher.js
  - scripts/lib/prompt-context.js
  - scripts/lib/plan-implement-chain.js
  - scripts/lib/subagent-block.js
  - scripts/lib/agent-exit-signals.js
  - scripts/lib/claude-account.js
  - scripts/sanitize-log.js
---

# Execução

Execução é o que acontece entre decidir despachar um nó e o agente sair. O `prompt-context.js`
pré-monta o que entra no prompt dos nós `plan` e `review` (descrição truncada, nomes de
arquivos, diff real), para não reler arquivos inteiros a cada turno. O `claude-account.js`
escolhe a conta do Claude Code e o `subagent-block.js` monta o bloqueio de subagente no argv do
`claude -p`. O `sanitize-log.js` apaga segredos de tudo o que o agente imprime e, quando o agente
sai, o `agent-exit-signals.js` separa "Claude indisponível" de "sessão estourou o contexto".

`WATCHER_PLAN_IMPLEMENT_CHAIN` (desligada por padrão) troca `plan` e `implement` por um segmento
numa sessão só. `WATCHER_PLAN_DENY_SETTINGS` (desligada por padrão) manda o bloqueio de
subagente por `permissions.deny`, em vez de `--disallowedTools`. O despacho em si está em
`dispatchTicket`, no watcher, e o `node-dispatcher.js` o reusa para o replay e o dashboard.

## Por onde começar

1. [`scripts/lib/node-dispatcher.js`](../../scripts/lib/node-dispatcher.js): despachar um nó fora do tick, delegando ao watcher.
2. [`scripts/lib/prompt-context.js`](../../scripts/lib/prompt-context.js): o contexto de entrada de `plan` e `review` e por que ele existe.
3. [`scripts/lib/subagent-block.js`](../../scripts/lib/subagent-block.js): as duas formas de bloquear subagente e as duas flags.
4. [`scripts/lib/plan-implement-chain.js`](../../scripts/lib/plan-implement-chain.js): o segmento `plan` + `implement` e quando ele vale.
5. [`scripts/readmine-watcher.js`](../../scripts/readmine-watcher.js): `dispatchTicket`, onde tudo isso se junta.
