# Plano: PRI-374, esforço de `subagent_roles` conferido pelo valor mapeado

Spec: `tasks/pri-374/SPEC.md` (aprovada em 15/11/2026, opção **A**). Nível Médio. Tarefas em `tasks/pri-374/todo.md`. Base: `main` `4d3c2a5`.

## Visão geral

Uma conferência a mais em `validateDecompositionSections`: o valor de `effort_map[spec.effort]` precisa estar em `CLI_EFFORTS`. Como `snapshotIntegrity` (`model-routing.js:114`) chama `validateRoutedPolicy`, a mesma regra recusa o snapshot ao retomar, sem mudar nada em `model-routing.js`.

## Grafo de dependências

```
validateDecompositionSections (model-routing-policy.js:202-209)
    ├── validateRoutedPolicy → readRoutingPolicy (carregamento)        → T1
    └── validateRoutedPolicy → snapshotIntegrity → resolveRoute (retomada) → T2
                                                                           → T3 (suíte, PR, Linear)
```

## Decisões de arquitetura

- **Opção A** (Q1 da spec): conferir só o valor usado pelo papel. Chave extra sem uso com valor inválido continua aceita, e um teste fixa isso para a escolha não mudar sem querer.
- **Ordem no loop:** a nova conferência vem logo depois de `subagent_role_effort_invalid` e antes da igualdade `default` == `default_route`. Assim o papel `default` com esforço `turbo` dá `subagent_role_effort_value_invalid:default`, e não `..._differs_...`.
- **Nada em `model-routing.js`:** a resolução já recusa por `snapshot_policy_invalid`. `subagentRoles` e `effort_enforcement: 'UNKNOWN'` ficam como estão.
- Detalhes de erro que já existem não mudam de nome.

## Tarefas

### Fase 1: carregamento e retomada
- [ ] T1: policy com esforço de papel fora de `CLI_EFFORTS` é recusada no carregamento (testes primeiro, depois o código). S, 2 arquivos.
- [ ] T2: snapshot com essa policy é recusado na resolução (`snapshot_policy_invalid`). XS, 1 arquivo de teste.

### Checkpoint 1
- [ ] Testes focados verdes; o teste de T1 falha sem a mudança (vermelho registrado).

### Fase 2: entrega
- [ ] T3: suíte oficial, revisão G3, PR em draft e Estado da issue (AC-02). Sem código novo.

### Checkpoint 2
- [ ] AC-01 a AC-03 com evidência no PR; aceite do Richard.

## Riscos

| Risco | Impacto | Mitigação |
|---|---|---|
| Snapshot gravado com papel inválido passa a ser recusado ao retomar | Baixo: só a `p2-pilot` tem `subagent_roles`, e é válida | Conferido na spec; T2 prova o comportamento; nenhum snapshot é reescrito |
| Ordem errada no loop gera um detalhe enganoso para o `default` | Baixo | Teste específico do `default` em T1 |
| `effort_map` ausente com `subagent_roles` | Nenhum: `validateRoutedPolicy` já recusa `effort_map_invalid` antes | Usar `raw.effort_map[...]` só depois da checagem de chave |

## Paralelismo

Nenhum. São três tarefas pequenas em sequência, numa sessão só. A revisão G3 roda num subagente Claude em contexto limpo (T3).

## Perguntas abertas

Nenhuma.
