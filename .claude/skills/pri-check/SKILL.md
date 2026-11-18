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
`EV="$HOME/Workspace/prisma-evidence/<issue>/$(git rev-parse --short HEAD)"`, com `<issue>` tirado do `context.json`.

## 1. Testes (pré-voo; a prova oficial é a CI no SHA final)

- Só docs e skills (`*.md`, `.claude/skills/`): não há suíte. Diga isso.
- Mexeu em `.github/scripts/` ou `.claude/hooks/`:
  `node --test .github/scripts/*.test.mjs .claude/hooks/*.test.mjs`. O harness não
  roda esses testes.
- Mexeu em `scripts/` ou `dashboard/`: na raiz, `npm test > "$EV/suite.tap" 2>&1`
  (é a receita oficial da CI) e `npm run check`. Se faltar `node_modules`, rode antes
  `npm ci --ignore-scripts --no-audit --no-fund --prefix <pacote>`.
- Teste novo (Médio e Alto): numa worktree descartável da `origin/main`, copie só os
  arquivos de teste novos, rode o `npm ci` do pacote e depois `npm run test:changed`. Eles
  precisam **falhar por asserção** lá; `MODULE_NOT_FOUND` não conta.
  Teste que passa na `main` não prova o AC: aponte isso.
- Para comparar uma falha com a `main`, use uma worktree limpa. Nunca `git stash`.
- Falha, timeout ou saída ausente não viram PASS: registre UNKNOWN com o motivo.

## 2. Revisão independente (única rodada, regra 6)

**Antes do revisor: capacidades e delta.**

- Reconfira a lista do `/pri-start` contra o diff: para cada arquivo de
  `git diff --name-status -M origin/main...HEAD` (nas linhas `R`, o nome antigo e o novo),
  rode `node scripts/capability-map.js --of <caminho>`. Capacidade que o diff toca e não está em
  `capacidades` do `.prisma/context.json` entra na lista (e no contexto).
- Delta. Com SPEC (Alto, ou Médio que escreveu uma): é a seção "Delta de capacidade" da
  `<pasta>/SPEC.md`; confira que ela vale para o diff final. Sem SPEC (Leve, ou Médio que
  dispensou a SPEC) e com o PR ainda por abrir, escreva o rascunho do delta em `~/Workspace/prisma-evidence/<issue>/delta.md` (uma linha por
  requisito ou invariante que muda, com o ID, ou "Nenhum" e o motivo). O `/pri-pr` copia
  esse texto para o corpo do PR.

Lance o revisor com o Agent tool, em contexto limpo e numa só mensagem:

| Nível | Revisor |
| -- | -- |
| Leve | `agent-skills:code-reviewer` com `model: "sonnet"` (decisão D-b de 16/11/2026) |
| Médio | `agent-skills:code-reviewer` com `model: "opus"` (G3) |
| Alto | `agent-skills:code-reviewer` e mais um, `agent-skills:security-auditor` (credencial, superfície externa) ou `agent-skills:test-engineer`, ambos com `model: "opus"` |

O brief leva o comando do diff (`git diff -M origin/main...HEAD`), a SPEC ou os ACs
da issue, as regras do `CLAUDE.md` e do `AGENTS.md`, a spec viva de cada capacidade da
lista (`docs/capacidades/<id>.md`, a versão da `origin/main` e a do HEAD) e o delta. O
pedido é focado:

- cada AC atendido ou não, com `arquivo:linha`;
- por capacidade, se o diff muda comportamento descrito na spec viva (requisito ou
  invariante) e a página dela não foi atualizada, ou se o delta diz "Nenhum" e o diff
  mostra o contrário: é Required, com `arquivo:linha` do código e o ID da spec; comportamento
  novo que a spec viva não descreve também conta;
- quebra de invariante (flag desligada, separação plataforma/consumidor, nada de
  dado corporativo, segredo);
- regressão e teste ausente.

O revisor não opina sobre estilo nem elogia. Ele classifica os achados como Critical,
Required, Optional ou Nit, termina com o veredito PASS ou FAIL e não edita arquivos.

**FAIL:** corrija e devolva só o novo diff ao mesmo revisor (SendMessage) para ele
conferir. Se a sessão do revisor se perdeu, um revisor novo que confere só as
correções não conta como segunda rodada. Com a conferência PASS, refaça a seção 1 no
SHA novo e grave o registro abaixo nesse SHA, com `"revisao": {"agente", "veredito": "PASS", "conferencia_de": "<sha revisado antes>"}`.

## 3. Registro

Grave `$EV/check.json` com `{"sha", "nivel", "suites": {"<nome>": exit}, "checks": exit, "testes_novos_falham_na_main": true|false|null, "revisao": {"agente", "veredito"}}` e o relatório bruto do revisor em `$EV/review.md`. Resuma em até 6 linhas para a Evidência do `/pri-pr`.
