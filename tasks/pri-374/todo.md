# PRI-374: tarefas

Plano: `tasks/pri-374/plan.md`. Spec: `tasks/pri-374/SPEC.md` (opção A).

## T1: carregamento recusa esforço de papel fora de `CLI_EFFORTS`

**Descrição:** acrescentar a conferência do valor mapeado em `validateDecompositionSections`, com o comentário que registra a parte 2 da pré-condição (parte 1: PRI-336). Testes primeiro.

**Critérios de aceite:**
- [x] `effort_map.turbo = 'ultra'` + `subagent_roles.reviewer.effort = 'turbo'` → `[false, 'POLICY_INVALID', 'subagent_role_effort_value_invalid:reviewer']`.
- [x] O mesmo com o papel `default` (`effort: 'turbo'`) → `subagent_role_effort_value_invalid:default`.
- [x] Continuam válidos: `UNKNOWN` + `effort_ref`; papel com chave válida; e chave extra `turbo: 'ultra'` sem uso (opção A, fixada em teste).

**Verificação:**
- [x] Vermelho antes: `node --test scripts/lib/model-routing-policy-roles.test.js` falha nos dois testes novos de recusa.
- [x] Verde depois: o mesmo comando passa.

**Dependências:** nenhuma.
**Arquivos:** `scripts/lib/model-routing-policy.js`, `scripts/lib/model-routing-policy-roles.test.js`.
**Tamanho:** S.

## T2: resolução recusa snapshot com essa policy

**Descrição:** teste no padrão de `model-routing.test.js:119`: snapshot com hash coerente cuja policy tem `subagent_roles.reviewer.effort` mapeado para `ultra` → `resolveRoute` devolve `[false, 'CONFIG_UNVERIFIABLE', 'snapshot_policy_invalid']`, sem exceção.

**Critérios de aceite:**
- [x] O teste novo passa com T1 e falha sem ele (conferido revertendo T1 localmente).

**Verificação:**
- [x] `node --test scripts/lib/model-routing.test.js`

**Dependências:** T1.
**Arquivos:** `scripts/lib/model-routing.test.js`.
**Tamanho:** XS.

## Checkpoint 1
- [x] `node --test scripts/lib/model-routing-policy-roles.test.js scripts/lib/model-routing.test.js scripts/lib/model-routing-decomposed.test.js` verde.

## T3: suíte, revisão G3, PR e Linear

**Descrição:** fechar a entrega pelo Acordo v2 (Médio).

**Critérios de aceite:**
- [ ] Suíte oficial verde (skill `prisma-tests`: `scripts/` e `dashboard/` via `harness/run-tests.js`), incluindo os goldens ON/OFF e `routing-pilot-policy.test.js` (AC-03).
- [ ] Uma revisão G3 por subagente Claude em contexto limpo, sem achado bloqueante aberto.
- [ ] PR em draft com "Refs PRI-374", rótulo `processo:medio` e seção Evidência preenchida (vermelho → verde, saída da suíte, versão do commit).
- [ ] Estado da issue atualizado, com a linha da AC-02 (parte 2 da pré-condição; parte 1: PRI-336).

**Verificação:**
- [ ] O check `processo-check` passa no PR.
- [ ] Leitura de volta da issue no Linear.

**Dependências:** T1, T2.
**Arquivos:** nenhum de código.
**Tamanho:** XS.

## Checkpoint 2
- [ ] AC-01 a AC-03 com evidência no PR; aceite do Richard (o merge é dele).
