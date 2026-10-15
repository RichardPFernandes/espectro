---
description: Nó "Test" — escreve/roda os testes cobrindo a mudança revisada.
---
> Consumo externo da candidata PRI-60: `PRISMA_ROOT` aponta ao checkout fixado da
> plataforma; cwd/`REPO_PATH` e `memory/` pertencem ao consumidor/worktree.
> Referências a `scripts/`, `templates/`, `.graph/schemas/` e a este template são
> assets da plataforma, resolvidos por `PRISMA_ROOT`; configuração, spec e registros
> históricos continuam no consumidor. Não copiar/reatar estado para corrigir paths.
> Regras, toolchain e repositórios relacionados vêm de `memory/project.yaml` e da
> configuração explícita do consumidor. Exemplos históricos não definem defaults.


Task-id: $ARGUMENTS

Você está executando o nó **Test**.

O objetivo deste nó é **comprovar os Critérios de Aceite da spec** (a autoridade do
WHAT), não a interpretação deles no handoff ou no context — e deixar uma **matriz de
cobertura** por AC (`acceptance-evidence.json`), não só "os testes passaram". O Test
faz a avaliação de **execução**; o Review (estático, sobre o diff) já rodou antes e
não é refeito aqui.

0. **Portão de drift da spec**: antes de tudo,
   `node "$PRISMA_ROOT/scripts/lib/spec-authority.js" check memory/runs/$ARGUMENTS --node=test --write`.
   Exit 3 = spec mudou depois do Plan sem SPEC_CHANGE aprovado (`status="spec-drift"`
   já gravado): **pare**, sem rodar testes e sem mexer em `node`/`retries`.
1. Leia `handoff.md` (estado operacional + bloco `## Referência da Spec`), o
   `## Cobertura dos ACs` do `plan.md` (como cada AC foi atendido) e, do
   `context.md`, só o veredito do Review e o resumo da mudança. Os ACs a comprovar
   são os IDs **ativos** da spec (caminho em `## Referência da Spec` ou
   `state.json.spec_path`):
   `sed -n '/^## Critérios de Aceite/,/^## /p' <spec>`.
2. Delegue ao subagente de testes do projeto (ver `memory/project.yaml >
   agentes_por_dominio`, tipicamente `test-writer` — leia só essa seção:
   `sed -n '/^agentes_por_dominio:/,/^[a-z_]*:$/p' memory/project.yaml`) — feature já implementada e
   revisada, nunca no meio do desenvolvimento. O objetivo é **cobertura funcional por
   AC**, não cobertura de código. Passe a ele, explicitamente:
   - **ACs da spec**: caminho da spec + lista de IDs ativos (não uma paráfrase — ele lê
     o texto na spec);
   - **arquivos alterados**: `git diff <base>...HEAD --name-only` + working tree, de
     todos os worktrees do ticket;
   - **implementação**: o `## Cobertura dos ACs` do `plan.md` (qual passo/arquivo
     atende cada AC);
   - **testes existentes**: as classes de teste que já cobrem esses arquivos
     (`grep -rl '<Classe>' src/test`) — reaproveitar/estender antes de criar.
   Peça de volta, **por AC**: o(s) teste(s) que o comprova(m) como `Classe#metodo`
   (nomeado ou comentado com o ID, ex.: `// AC-02`), o tipo (`automated-test` = novo,
   `regression-test` = teste existente que protege comportamento mantido,
   `integration-test` = com banco/serviço real), ou por que o AC não é automatizável.
3. **Rode os testes da toolchain configurada no consumidor** (TEST_COMMAND e,
   quando pertinente, TEST_SCOPED_COMMAND), com as flags reais que habilitam seus
   testes. Guarde a saída e relatórios no run em evidence/. Não assuma Maven,
   Node ou um caminho de relatório pelo layout da plataforma. Em Java/Maven,
   `acceptance-evidence.js scan <diretorio-surefire>` é o adapter existente;
   outros formatos usam o artefato real admissível (log/testcase), sem fabricar
   resultados ou declarar teste pela memória. Repos relacionados usam apenas o
   escopo explicitamente configurado e autorizado.
4. **Matriz de cobertura** — escreva `memory/runs/$ARGUMENTS/acceptance-evidence.json`
   (sobrescreva a cada rodada; schema em `.graph/schemas/acceptance-evidence.schema.json`).
   Se `state.json.stale_artifacts` listar `acceptance-evidence.json` (SPEC_CHANGE
   aprovada — `scripts/lib/spec-change.js`), a matriz antiga é de outra versão da
   spec: regrave-a inteira sobre os ACs ativos atuais (o Verify tira da lista o que
   foi regravado e reprova enquanto houver artefato stale). O `finalize` (passo abaixo)
   é o único caminho de volta a VALID: carimba `validity` na matriz e em
   `state.json.artifact_validity.evidence` (`scripts/invalidate.js`) — nunca edite esses
   blocos à mão, nem reaproveite evidence de outra versão da spec.
   **Cada AC ativo da spec aparece exatamente uma vez** em `coverage`; várias
   evidências do mesmo AC ficam agrupadas no array `evidence`:

   ```json
   {
     "coverage": {
       "AC-01": {
         "status": "PASS",
         "evidence": [
           { "description": "ResumoServiceTest#filtraRemessa", "type": "automated-test",
             "artifact": "memory/runs/<task-id>/evidence/surefire/TEST-br.com...ResumoServiceTest.xml",
             "command": "mvn -q test -Dtest=ResumoServiceTest", "result": "PASS" }
         ]
       },
       "AC-03": {
         "status": "NOT_AUTOMATED",
         "justification": "Destaque é CSS do frontend consumidor; o projeto não tem teste visual automatizado.",
         "evidence": [
           { "description": "validação visual necessária", "type": "manual", "result": "NOT_AUTOMATED",
             "justification": "Sem infraestrutura de teste visual no consumidor." }
         ]
       }
     }
   }
   ```

   - **Tipos**: `automated-test`, `regression-test`, `integration-test`, `build`,
     `static-analysis`, `manual`, `not-applicable`.
   - **Resultado**: `PASS` (evidência confirma o AC), `FAIL` (contradiz/falha),
     `NOT_AUTOMATED` (não automatizável — não é FAIL, mas exige `justification`),
     `BLOCKED` (não avaliado por dependência externa — exige `justification`).
   - **`artifact` é obrigatório** para testes, `build` e `static-analysis` e aponta o
     artefato real que prova a execução: XML do surefire/failsafe (arquivo ou
     diretório), log (`.../mvn-test.log#L120` para uma linha). Caminho relativo à raiz
     do checkout ou ao run. O Verify confere que o arquivo existe, que o testcase está
     nele e que o resultado bate — `result` sozinho não vale nada.
   - **`status` do AC** = agregado das evidências: FAIL > BLOCKED > PASS >
     NOT_AUTOMATED (`not-applicable` não conta; AC ativo só com N/A é SPEC_CHANGE, não
     decisão do Test).
   - Não copie o texto dos critérios: o ID basta. `plan_steps`/`implementation` são
     opcionais (o `finalize` completa a partir do `plan.md`); preencha
     `implementation` com os arquivos realmente alterados quando divergirem do plano.

   Depois, carimbe e confira (o mesmo que o Verify vai checar):
   ```bash
   node "$PRISMA_ROOT/scripts/lib/acceptance-evidence.js" finalize memory/runs/$ARGUMENTS   # run_id, spec_hash, spec_version, summary, plan_steps
   node "$PRISMA_ROOT/scripts/lib/acceptance-evidence.js" render memory/runs/$ARGUMENTS --write  # ac-evidence.md (matriz legível)
   node "$PRISMA_ROOT/scripts/lib/acceptance-evidence.js" check memory/runs/$ARGUMENTS
   ```
   `finalize` com exit 1 = schema inválido ou AC ativo fora da matriz: corrija antes de
   seguir. O `finalize` carimba `spec_version`/`spec_hash` da spec que o Test usou (run
   legado: `spec_version: null`). `ALERTA SPEC_CHANGE mid-run` no stderr = a spec atual
   não é a versão registrada no state.json: não siga como se nada fosse — registre em
   `context.md` e pare (o portão de drift/SPEC_CHANGE decide). `check` com `[FAIL]` = a matriz não se sustenta nos artefatos.
5. Registre resultado (a matriz resumida: `AC-01 PASS · AC-02 PASS · AC-03
   NOT_AUTOMATED`, gaps de cobertura) em `context.md` e `state.json`
   (`current_agent="claude"`, entrada em `agent_log` no formato exato `{"agent": "claude", "nodes": ["test"], "at": "<ISO-8601 UTC>", "note": "<resumo curto>"}` (`agent` é obrigatório no schema; entrada sem ele faz o watcher marcar a task `state_corrupted` e parar o ciclo)).
6. Reescreva `handoff.md` para o Verify, preservando o bloco `## Referência da Spec`
   e citando os ACs `NOT_AUTOMATED` (o Verify os leva explicitamente adiante).

## Aresta condicional
- **Passou** (suíte verde, `acceptance-evidence.js check` sem `[FAIL]`: todo AC ativo
  `PASS`, ou `NOT_AUTOMATED` com justificativa) →
  `node "$PRISMA_ROOT/scripts/state-writer.js" transition memory/runs/<task-id> --from=test --to=verify`,
  rode `/verify $ARGUMENTS`.
- **Falhou** → `node "$PRISMA_ROOT/scripts/state-writer.js" transition memory/runs/<task-id> --from=test --to=implement --retry`
  (incrementa `retries.test` na mesma escrita, com CAS), registre o
  motivo em `context.md` (inclui os IDs `FAIL`/`BLOCKED`; `BLOCKED` por dependência
  externa que não se resolve no Implement → escale pro humano em vez de gastar retry), rode `/implement $ARGUMENTS` de novo.

Nunca edite `node`/`retries` no `state.json` à mão (`docs/concurrency-map.md`). Exit 3 = `STATE_CONFLICT`/`SESSION_CONFLICT` (o run mudou ou outra sessão assumiu — a CLI já re-tentou uma vez quando fazia sentido): pare sem gravar mais nada e reporte.

## Limite de loop
Se `retries.test >= 3`, pare e escale pro humano.

## Dependência externa privilegiada
Se o `BLOCKED` vier de algo que só uma ação privilegiada resolve (ex.: migration não
aplicada no banco compartilhado do ambiente), não escale só com texto: registre o
pedido estruturado como em `.claude/commands/implement.md` passo 3b
(`node "$PRISMA_ROOT/scripts/lib/authorization.js" request ...`) e pare — o humano
aprova no dashboard.
