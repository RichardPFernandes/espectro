# Plano: PRI-274 c2b-4-content

> Deriva de [SPEC.md](SPEC.md) (r1, **ainda sem aceite do Richard**). Em divergência, a SPEC vence.
> Nível Médio, flag `WATCHER_QA_DIAGNOSTICO` desligada. Lista em [todo.md](todo.md). Fica em
> `tasks/pri-274/` porque `tasks/plan.md` e `tasks/todo.md` são da PRI-233 (decisão do Richard em 14/11).
> Planejamento só leitura: nenhum código foi alterado.

## Visão geral

Hoje `validateVersion` (`scripts/lib/qa-diagnosis-model.js:138`) valida só o cabeçalho; as cinco seções de
conteúdo passam sem validação. O plano fecha o validador seção por seção, cada tarefa com seu AC. Antes
disso, retira o código C2/C3 morto que prende a taxonomia antiga.

## Grafo de dependência

```
código C2/C3 (layout, record, collect, analyze, publish, predicates, taxonomy antiga)
   └─ T1 retira o que não é usado pelo protocolo novo
        └─ T2 taxonomia exata + predicates → assertions pred:<id>@<ver>
             └─ T3 validateContent + §6.1 context/missing        (AC-01)
                  └─ T4 §6.2 assertions, regra FACT              (AC-04)
                       └─ T5 §6.3 cause, support, rules/0.1      (AC-02, AC-03 parcial)
                            └─ T6 §6.4 recommendation + platform_signals  (AC-02, AC-03)
                                 └─ T7 flag desligada, suíte, evidência no PR  (AC-05, AC-06)
```

Sequencial: todas as tarefas mexem em `qa-diagnosis-content.js` ou dependem do vocabulário da anterior.
Paralelizável: só os testes de mutação da T4–T6 depois que cada seção existe.

## Fatos lidos no código (main `a2e956b`)

- `validateVersion` é chamado em `qa-diagnosis-protocol.js:578` e `:935` (commit e reconciliador) e em
  `qa-diagnosis-store.js:148,187`. Endurecer o conteúdo muda o que esses quatro pontos aceitam. Os testes
  existentes que montam versões com conteúdo livre podem quebrar; T3 os revisa.
- Cadeia de imports dos módulos antigos: `analyze → collect → layout`; `analyze → predicates → taxonomy`;
  `publish → layout, record`. Por isso `layout` só sai junto com `collect` e `analyze`.
- Testes que importam os módulos antigos: `-collect`, `-analyze`, `-publish`, `-layout`, `-predicates`,
  `-taxonomy`, `qa-diagnosis-c2b1-flag-on/off.test.js` (lista `spied`) e `qa-diagnostico-flag.test.js:54`.
- `readmine-watcher.js:6004` ainda imprime `LIGADO (C1–C3)`. Não achei chamada a `analyzeRejection` nem a
  `publishDiagnosisRecord` no watcher; T1 confirma antes de apagar.
- `scripts/package.json` roda `lib/*.test.js`: teste novo em `lib/` entra sem editar a lista.

## Decisões de arquitetura

- Validação em arquivo novo `qa-diagnosis-content.js`, JavaScript puro e sem ajv, chamado por
  `validateVersion`. Mantém a regra da c2b-1: a condição (e) do §4.3.1 não depende de ajv.
- Validação cruzada (assertion → `evidence_ids` → `sources[]`) no mesmo módulo, não no protocolo.
- Sem alias entre a taxonomia antiga e a da SDD (Q4, recomendação).

## Riscos

| Risco | Impacto | Mitigação |
|---|---|---|
| Endurecer `validateVersion` quebra os testes do protocolo e do store que usam conteúdo livre | Alto | T3 roda `qa-diagnosis-protocol/store*.test.js` primeiro e corrige só as fixtures de conteúdo, nunca o oráculo |
| Retirada apaga teste de oráculo da c0b (`qa-diagnostico-flag`) | Médio | T1 só ajusta o `require`/`spied`; a expectativa não muda |
| Q1 e Q2 da SPEC sem decisão do Richard | Médio | T5 e T6 usam as recomendações; delta fica nomeado no PR |
| `support` MODERATE sem tabela de regras na SDD | Médio | `rules/0.1` mínima (Q2), marcada como delta a registrar na SDD |

## Perguntas abertas (herdadas da SPEC)

Q1 forma de `platform_signals` (bloqueia T6). Q2 tabela `rules/0.1` (bloqueia T5). Q3 retirar × adaptar
`-predicates` (bloqueia T1/T2). Q4 taxonomia 13×11 (bloqueia T2). Defaults = recomendações da SPEC; vale o
default se não houver objeção até a próxima janela (segunda ou quinta).

## Checkpoints

- **Após T2:** suíte verde, nenhum módulo antigo restante além do `predicates` adaptado, `LIGADO (C1–C3)` fora.
- **Após T4:** FACT só por predicado de sistema, provado por mutação.
- **Após T6:** AC-01 a AC-04 verdes; revisão do Richard antes da T7.
- **T7:** suíte completa, PR em draft com Evidência; G3 (1 revisor); AUTORIZO D-C2b-4.
