---
description: Verificação de UI em navegador real (Playwright MCP) dos ACs afetados — chamada pelo /verify (passo 2b) ou à mão.
---
> Consumo externo da candidata PRI-60: `PRISMA_ROOT` aponta ao checkout fixado da
> plataforma; cwd/`REPO_PATH` e `memory/` pertencem ao consumidor/worktree.
> `scripts/` e `.agents/` são assets da plataforma, resolvidos por `PRISMA_ROOT`
> (`node "$PRISMA_ROOT/scripts/ui-verify.js" …`); spec e registros ficam no consumidor.

Task-id: $ARGUMENTS

Este comando **não é um nó do grafo** e não faz transição. Ele só devolve um veredito.
Siga `$PRISMA_ROOT/.agents/skills/prisma-ui-verify/SKILL.md` (procedimento e regras de segurança), com a spec do
run (`memory/runs/$ARGUMENTS`) como fonte dos ACs de UI.

- Flag desligada (`PRISMA_UI_VERIFY` ausente ou `off`): responda `SKIPPED` e pare. Rodar à mão exige
  `PRISMA_UI_VERIFY=on`. Valor que não seja `on` ou `off` é erro.
- Sem as ferramentas `mcp__playwright__*` na sessão (servidor MCP não aprovado ou não carregado):
  **UNKNOWN/bloqueado**, nunca `PASSOU`. Diga como habilitar (`docs/ui-verify.md`).
- Saída: `Veredito: PASSOU|FALHOU|N/A|SKIPPED`, lista `[CÓDIGO] AC tela: detalhe` e o diretório
  `.prisma/ui-verify/$ARGUMENTS/`. Screenshots não vão ao PR nem ao Linear.
- Sempre encerre o servidor que você subiu (`node "$PRISMA_ROOT/scripts/ui-verify.js" server stop`).
