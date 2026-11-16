---
name: pri-check
description: Antes do PR de uma issue PRI, roda checagens e suíte pela receita oficial, prova que os testes novos falham na main e faz a revisão independente por subagente em contexto limpo; grava check.json.
disable-model-invocation: true
argument-hint: "[PRI-NNN]"
---

# /pri-check

Contexto em `.prisma/context.json`. Pare se o arquivo não existir ou se o `branch`
dele divergir de `git branch --show-current`. Comece com a árvore limpa
(`git status --porcelain` vazio): a evidência fica presa ao SHA do HEAD.
`EV="$HOME/Workspace/prisma-evidence/<issue>/$(git rev-parse --short HEAD)"`.

## 1. Testes (pré-voo; a prova oficial é a CI no SHA final)

- Só docs e skills (`*.md`, `.claude/skills/`): não há suíte. Diga isso.
- Mexeu em `.github/scripts/` ou `.claude/hooks/`:
  `node --test .github/scripts/*.test.mjs .claude/hooks/*.test.mjs`. O harness não
  roda esses testes.
- Mexeu em `scripts/` ou `dashboard/`: rode a receita da seção "Primeiros passos" do
  `README.md`, que é a mesma da CI, com `HOME` e `TMPDIR` dentro de `$EV`. Rode antes o
  `npm ci --ignore-scripts --no-audit --no-fund --prefix <pacote>` só se faltar o
  `node_modules`. Depois rode
  `npm --prefix scripts run check:js && npm --prefix scripts run arch:check`.
- Teste novo (Médio e Alto): numa worktree descartável da `origin/main`, copie só os
  arquivos de teste novos e rode `node --test` neles. Eles precisam **falhar** lá.
  Teste que passa na `main` não prova o AC: aponte isso.
- Para comparar uma falha com a `main`, use uma worktree limpa. Nunca `git stash`.
- Falha, timeout ou saída ausente não viram PASS: registre UNKNOWN com o motivo.

## 2. Revisão independente (única rodada, regra 6)

Lance o revisor com o Agent tool, em contexto limpo e numa só mensagem:

| Nível | Revisor |
| -- | -- |
| Leve | `agent-skills:code-reviewer` com `model: "sonnet"` (decisão D-b de 16/11/2026) |
| Médio | `agent-skills:code-reviewer` (G3) |
| Alto | `agent-skills:code-reviewer` e mais um: `agent-skills:security-auditor` (credencial, superfície externa) ou `agent-skills:test-engineer` |

O brief leva o comando do diff (`git diff -M origin/main...HEAD`), a SPEC ou os ACs
da issue e as regras do `CLAUDE.md` e do `AGENTS.md`. O pedido é focado:

- cada AC atendido ou não, com `arquivo:linha`;
- quebra de invariante (flag desligada, separação plataforma/consumidor, nada de
  dado corporativo, segredo);
- regressão e teste ausente.

O revisor não opina sobre estilo nem elogia. Ele classifica os achados como Critical,
Required, Optional ou Nit, termina com o veredito PASS ou FAIL e não edita arquivos.

**FAIL:** corrija e devolva só o novo diff ao mesmo revisor (SendMessage) para ele
conferir. Se a sessão do revisor se perdeu, um revisor novo que confere só as
correções não conta como segunda rodada.

## 3. Registro

Grave `$EV/check.json` com `{"sha", "nivel", "suites": {"<nome>": exit}, "checks": exit, "testes_novos_falham_na_main": true|false|null, "revisao": {"agente", "veredito"}}` e o relatório bruto do revisor em `$EV/review.md`. Resuma em até 6 linhas para a Evidência do `/pri-pr`.
