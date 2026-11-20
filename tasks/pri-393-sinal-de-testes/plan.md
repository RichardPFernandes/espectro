# Plano PRI-393: sinal confiável da suíte de testes

SPEC: [`SPEC.md`](SPEC.md). Tarefas: [`todo.md`](todo.md). Código lido em `main` `73a5dba`.

## Resumo

Doze tarefas em três fases, um PR em draft por fase (`Refs PRI-393`, rótulo `processo:medio`).
A fase 1 deixa a suíte verde e a versão de Node declarada. A fase 2 impede a suíte de escrever
no checkout. A fase 3 impede que um teste deixe de rodar ou trave em silêncio. Toda tarefa
começa pelo teste que falha.

## Decisões de desenho

1. **Um ponto só: `harness/run-tests.js`.** A CI, o `npm test` e o `test:changed` passam todos
   por ele. A guarda do checkout, o tempo limite, a recusa de arquivo ausente e a versão de Node
   entram ali, e não em `recipe.js` nem no YAML da CI. Assim a receita, hoje escrita em quatro
   lugares, não precisa mudar em nenhum deles.
2. **Guarda por retrato do disco, não por `git status`.** Antes e depois da suíte, o harness
   percorre o checkout (fora `.git` e `node_modules`) e compara caminho, tamanho e data de
   modificação. Funciona em export sem git e enxerga arquivo ignorado e arquivo já modificado.
   Fica em `harness/checkout-guard.js`.
3. **O log de conflitos vai para o TMPDIR pelo ambiente, sem tocar `scripts/cas.js`.** O
   `cas.js` já respeita `STATE_CONFLICTS_LOG` (`scripts/cas.js:449`). O harness define essa
   variável dentro do TMPDIR sintético. A correção da resolução de caminho continua na PRI-372.
4. **Os testes de build compilam numa cópia no TMPDIR.** `scripts/platform-roots.test.js` já
   tem os ajudantes de cópia (`copyDir`, `linkCompiler`) para o caso "cópia isolada"; os testes
   que hoje rodam `tsc -b` no pacote passam a usar a cópia.
5. **Execução estrita num módulo compartilhado.** `harness/strict-run.js` recusa arquivo
   ausente e execução com zero testes. O `run-tests.js` e o `processo-check` usam o mesmo
   módulo; o checkout esparso do `processo-check` ganha `harness`.
6. **Versão mínima lida de um lugar.** `engines.node` do `package.json` da raiz é a fonte; o
   harness lê dali. `.nvmrc` aponta para 24.
7. **Perguntas abertas da SPEC: vale a recomendação** (regra 8). Sem Postgres na CI nesta
   issue, matriz 22 e 24 mantida, e2e da PRI-69 continua excluído.

## Grafo de dependências

```text
T1 realpath ─┐
T2 handoff ──┼─→ suíte verde ─→ T5 guarda (módulo) ─→ T6 log no TMPDIR ─┐
T3 Node ─────┤                                       T7 build no TMPDIR ─┼─→ T8 guarda ligada
T4 CI estática┘                                                          ┘
suíte verde ─→ T9 execução estrita ─→ T10 processo-check
suíte verde ─→ T11 tempo limite
suíte verde ─→ T12 test:changed
```

As fases 2 e 3 não dependem uma da outra. T9, T11 e T12 tocam arquivos diferentes e podem
andar em paralelo; T5 a T8 são sequenciais.

## Fases e PRs

| Fase | Tarefas | ACs | PR |
| -- | -- | -- | -- |
| 1. Base verde | T1 a T4 | AC-01, AC-02, AC-03, AC-05 | PR 1 |
| 2. Checkout intocado | T5 a T8 | AC-06 | PR 2 |
| 3. Nada em silêncio | T9 a T12 | AC-04, AC-07, AC-08 | PR 3 |

Cada PR fecha com a suíte inteira verde pela receita no Mac e o job da CI verde no Linux.

## Riscos

| Risco | Impacto | Como se trata |
| -- | -- | -- |
| A guarda acusa quem edita arquivo durante a suíte | Médio | A mensagem lista os caminhos. Vale para a rodada inteira; `test:changed` com arquivos explícitos também passa pela guarda |
| Há outro teste que escreve no checkout além dos três conhecidos | Médio | T5 entrega a guarda só relatando; T8 só liga a falha depois de a lista zerar |
| `validate-handoff.test.js` usa `/workspace` por uma regra do validador que recusa caminho temporário | Médio | T2 começa lendo a regra de `pre-done`. Se for isso, o teste cria o diretório dentro do TMPDIR da receita e a regra é ajustada no teste, não no validador |
| 120 s interrompe suíte lenta sob carga | Baixo | O mais lento medido é 56 s no Mac e 43 s na CI. T11 mede com o limite ligado antes de fixar o número |
| `--test-timeout` não cobre arquivo que termina os testes e fica com processo aberto | Baixo | Fora do AC-08. O limite de 15 minutos do job continua valendo; registrar no PR |
| Conflito com o PR #176, que muda a mesma linha do `processo-check` | Baixo | T10 parte do que estiver na `main` no dia |
| Job novo de checagem estática pode não estar entre os checks exigidos | Baixo | Richard decide se entra na proteção da branch ao mesclar o PR 1 |

## Fora deste plano

Itens 9 a 11 da validação (receita única, testkit, cobertura), a PRI-372 e a aceleração de
`scripts/lib/routing-off-golden.test.js`.
