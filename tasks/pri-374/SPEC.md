# SPEC: PRI-374, esforço de `subagent_roles` conferido pelo valor mapeado

> **Status:** v1, **aprovada pelo Richard em 15/11/2026**, com a opção A (Q1). Plano em `tasks/pri-374/plan.md`. Nível **Médio** (sem efeito no consumidor hoje: o esforço de subagente é só declarado). Issue: [PRI-374](https://linear.app/prisma-app/issue/PRI-374), filha da PRI-352, ligada à PRI-336. Código lido em `main` `4d3c2a5`. RC-1 a RC-6 e RRC-F31-001/002 seguem NOT APPLIED.

## Contexto

`validateDecompositionSections` (`scripts/lib/model-routing-policy.js:202-209`) aceita `subagent_roles.<papel>.effort` desde que seja uma **chave** de `effort_map`, sem olhar o **valor**. `validateRoutedPolicy` (`:178-182`) só confere contra `CLI_EFFORTS` as chaves usadas por `class_to_tier` e `default_route`. Por isso `effort_map.turbo = 'ultra'` com `subagent_roles.reviewer.effort = 'turbo'` passa no carregamento.

Hoje isso não gera nada: `subagentRoles` (`scripts/lib/model-routing.js:416`) grava `effort_enforcement: 'UNKNOWN'` e o `--agents` troca só o modelo. O risco aparece no dia em que o esforço de subagente for aplicado. A PRI-336 fechou o mesmo buraco para o override humano (`model-routing.js:309-315`).

**Policies conhecidas, todas válidas nas duas opções abaixo:** `p1-2026-11-06` (aprovada, a do app-back, sem `subagent_roles`), `p2-pilot-2026-11-16` (`.claude/model-routing-policy.json`, com `subagent_roles.default` = `alto`) e o rascunho em `prisma-evidence/2026-11-09-jev-app-back`. Todas têm `effort_map` = `{baixo: low, médio: medium, alto: high, máximo: max}`.

**Snapshot:** `model-routing.js:114` revalida `snapshot.policy` com `validateRoutedPolicy` ao retomar uma Run. Toda regra nova no carregador vale também para snapshots já gravados.

## Objetivo

Uma policy cujo papel de subagente mapeia para um esforço fora de `CLI_EFFORTS` é recusada com `POLICY_INVALID`, antes de qualquer Run, e o snapshot dela é recusado ao retomar. Com isso fica pronta a segunda parte da pré-condição para aplicar esforço de subagente (a primeira foi a PRI-336).

## Escolha (recomendação: opção A)

- **A (recomendada), conferência estreita:** em `validateDecompositionSections`, além da chave, exigir `CLI_EFFORTS.has(effort_map[spec.effort])`. Detalhe novo: `subagent_role_effort_value_invalid:<papel>`, no mesmo padrão de `effort_map_value_invalid:<esforço>`. Mantém a regra que já existe (só se confere o que é usado), fecha o caminho do subagente e não muda o que vale para chaves sem uso. O override já está coberto pela PRI-336.
- **B, conferir todo o `effort_map`:** recusa qualquer valor fora de `CLI_EFFORTS`, usado ou não. Fecha os dois caminhos numa regra só, mas passa a invalidar policy e snapshot com chave extra que hoje é inofensiva, o que mexe na leitura do histórico além da brecha (AGENTS.md regra 5). Nenhuma policy conhecida quebra.

`effort: 'UNKNOWN'` com `effort_ref` continua válido nas duas opções (U1).

## Critérios de Aceite

- AC-01: policy com `effort_map.turbo = 'ultra'` e `subagent_roles.reviewer.effort = 'turbo'` → `{ ok: false, cause: 'POLICY_INVALID', detail: 'subagent_role_effort_value_invalid:reviewer' }`. O mesmo vale para o papel `default`. Snapshot com essa policy → `snapshot_policy_invalid` na resolução. Testes novos.
- AC-02: comentário no código, junto da conferência, e linha no Estado da issue dizendo que esta é a parte 2 da pré-condição para aplicar esforço de subagente (parte 1: PRI-336).
- AC-03 (não regressão): a `p2-pilot-2026-11-16` e o envelope `p1` do teste continuam válidos, e `UNKNOWN` + `effort_ref` também. Os testes de roles, decomposição e goldens ON/OFF continuam verdes.

## Comandos e estrutura

- Foco: `node --test scripts/lib/model-routing-policy-roles.test.js scripts/lib/model-routing-decomposed.test.js`
- Receita oficial (skill `prisma-tests`): `cd scripts && npm test` via `harness/run-tests.js`, com `REPO_PATH` e `PRISMA_ROOT` absolutos; depois o pacote `dashboard/`.
- Arquivos: `scripts/lib/model-routing-policy.js` (validação), `scripts/lib/model-routing-policy-roles.test.js` (testes ao lado, usando o `policy(extra)` que já existe). Teste de snapshot em `scripts/lib/model-routing-decomposed.test.js`, ou no arquivo de roles se o helper permitir.

```js
} else if (!efforts.has(spec.effort)) {
    return fail(`subagent_role_effort_invalid:${role}`);
} else if (!CLI_EFFORTS.has(raw.effort_map[spec.effort])) {
    // PRI-374: parte 2 da pré-condição para aplicar esforço de subagente (parte 1: PRI-336).
    return fail(`subagent_role_effort_value_invalid:${role}`);
}
```

## Boundaries

- **Sempre:** PR em draft com "Refs PRI-374" e rótulo `processo:medio`; evidência na seção Evidência do PR; uma revisão G3 por outro agente Claude em contexto limpo.
- **Perguntar antes:** escolher B em vez de A; qualquer mudança em policy publicada (`p1`, `p2-pilot`) ou em `effort_map`; aplicar esforço de subagente (fora do escopo, seria Alto).
- **Nunca:** tocar no `app-back` ou no estado dele; mudar `effort_enforcement` de `UNKNOWN`; renomear detalhes de erro que já existem; reescrever snapshot gravado.

## Decisão

- **Q1 (decidida em 15/11/2026):** opção **A**. O Richard aprovou a spec com a recomendação. Mesa de Decisões: `D-PRI-374-01`.
