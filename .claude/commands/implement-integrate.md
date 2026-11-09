---
description: Integração do Implement decomposto — autoverificação e ajustes de junção das subtarefas, sem transição de nó.
---
> Consumo externo da candidata PRI-60: `PRISMA_ROOT` aponta ao checkout fixado da
> plataforma; cwd/`REPO_PATH` e `memory/` pertencem ao consumidor/worktree.
> Referências a `scripts/`, `templates/` e a este template são assets da plataforma,
> resolvidos por `PRISMA_ROOT`. Não copiar/reatar estado para corrigir paths.

Task-id: $ARGUMENTS

Você está executando a **integração** do nó Implement de uma Run decomposta (PRI-287 S5):
todas as subtarefas desta versão do plano já foram aceitas pelo orquestrador. O bloco
`<!-- integration-context:…:inicio -->…:fim -->` no fim do prompt lista as subtarefas
(e o rework desta visita, se houve).

## Passos

1. Leia `memory/runs/$ARGUMENTS/state.json`, `plan.md` e `handoff.md`, inclusive os
   blocos `<!-- subtask:<chave>:inicio -->…:fim -->` de cada subtarefa.
2. **Autoverificação da junção:** confira que o conjunto das subtarefas cumpre o plano
   inteiro — interfaces entre arquivos de grupos diferentes, imports, assinaturas,
   configuração compartilhada, pendências que as subtarefas deixaram para a integração.
   Faça só os **ajustes de junção** necessários; não reimplemente subtarefa aceita.
3. **Mesmas regras do `/implement`, por referência:** leia
   `$PRISMA_ROOT/.claude/commands/implement.md` e aplique a governança de decisão (passo
   3a, com pausa em `SPEC_CHANGE`), o pedido de autorização (3b) e os passos 4 a 7 —
   **exceto** a transição:
   - grave os campos de registro do passo 4 pelo `state-writer.js set` (`updated_at`,
     `current_agent`), mas **não** rode `state-writer.js transition` e não mexa em `node`,
     `history`, `retries` nem `agent_log` de nó: quem transiciona implement → review é o
     orquestrador, depois de aceitar esta integração e agregar as subtarefas;
   - passo 5: acrescente ao `context.md` o resumo do que a integração ajustou;
   - passo 6: reescreva o `handoff.md` para o Review **preservando** o bloco
     `## Referência da Spec` e **todos** os blocos `subtask:*`, sem alterá-los;
   - passo 7: spec como contrato vivo, só APPEND.
4. Não rode `/review` (a Review é despachada pelo orquestrador) e não crie commit, branch
   nem push.

Pare assim que terminar o passo 3.
