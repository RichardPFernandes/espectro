# PRI-405 · Números de ticket do consumidor em testes e prompts (F0.1)

Nível Médio. Fonte das decisões: D-PRI-401-01 (Mesa de Decisões, itens 4 e 5, aprovada em
18/11/2026). Entrada: os ACs da issue; não há SPEC.

## Levantamento (main d10842b)

- Testes: 52 arquivos `*.test.js` com número na faixa do tracker, 640 ocorrências em 571 linhas.
  Nenhuma ocorrência em `**/fixtures/**`.
- Prompts: 9 números em 3 arquivos (`commit.md`, `fetch-ticket.md`, `plan.md` de
  `.claude/commands/`) e 1 título de ticket real (`commit.md`, exemplo de título de PR).
- Fora do escopo e não são ticket: durações em milissegundos nos testes (6 linhas em
  `dashboard/compare-model.test.js`, `dashboard/server.test.js`, `dashboard/system-model.test.js`
  e `scripts/lib/spec-repairer.test.js`). Ficam como estão e são listadas na Evidência.
- `dashboard/README.md` ainda tem 3 linhas com número; a troca está no PR #198 (aberto), não aqui.

## Regra de troca (uma só, para testes e prompts)

1. Número que o mapa da F0.1/F1.9 já trocou (commits `dce3118` e `3f19aa7`: ticket vira
   `10001+`, journal vira `20001+`) usa o mesmo marcador. Cobre 18 dos 87 valores distintos
   dos testes.
2. O resto: menos 30000 (preserva ordem e 5 dígitos).
3. O mapa é reconstruído no build a partir do `git show` desses dois commits e fica só no
   scratchpad. **Nenhum número real entra no repo, no plano, no PR ou no Linear.**
4. Antes de gravar, cada arquivo passa por checagem de colisão: o valor de destino não pode já
   existir no mesmo arquivo com outro sentido. Se um teste depender da ordem entre um número do
   mapa e um deslocado e quebrar, esse arquivo usa só o menos 30000; o PR diz quais.

## Entrega: 4 PRs

O limite de 400 linhas do Leve conta adições e remoções: 571 linhas viram cerca de 1.130.
Por isso são **3 PRs Leve de teste**, não 2 como a issue previa (cerca de 378, 376 e 376
linhas; a divisão por arquivo está no `todo.md`). O escopo não muda.

| PR | Branch (de `origin/main`) | Nível | Conteúdo |
| -- | -- | -- | -- |
| A | `RichardPFernandes/pri-405-testes-a` | Leve | grupo A de testes |
| B | `RichardPFernandes/pri-405-testes-b` | Leve | grupo B de testes |
| C | `RichardPFernandes/pri-405-testes-c` | Leve | grupo C de testes |
| D | `RichardPFernandes/pri-405-tickets-testes` (esta) | Médio | prompts, hash do AC-29, F0.1 concluída e este plano |

Os PRs de teste não mexem no que roda numa Run e saem antes. O D só chega ao consumidor no
próximo bump, que tem AUTORIZO próprio.

## Verificação

- AC-01: `git grep -nwE "4[0-9]{4}" -- '*.test.*' '**/fixtures/**'` só devolve as 6 linhas de
  duração e o hash do AC-29 (não é número de ticket). Cada tarefa roda esse grep nos seus
  arquivos antes (acha) e depois (zero).
- AC-02: `npm run test:changed` em cada tarefa; `npm test` e `npm run check` na raiz no
  `/pri-check` de cada PR; prova final é o run da CI. Nenhum teste pulado a mais que na main.
- AC-03: grep nos prompts devolve zero; o AC-29 falha depois da troca e volta a passar com o
  hash novo do `commit.md` (`implement.md` e `review.md` não mudam).
- AC-04: linha da F0.1 e critério de saída da Fase 0 atualizados no PR D.

## Riscos

- Teste que monta string de outro teste (ex.: nome de run `NNNNN-slug` reaproveitado entre
  arquivos de grupos diferentes). Mitigação: `npm test` completo no `/pri-check` de cada PR.
- O critério de saída da F0.1 também depende do PR #198 (README do dashboard). Se o #198 não
  estiver mesclado quando o PR D abrir, a F0.1 fica `em andamento` e o PR diz isso.
- A linha da F0.1 está como Leve e cita só a PRI-376; esta issue é Médio. O PR D acrescenta a
  PRI-405 na coluna da issue e mantém o nível da fatia (Leve), com a nota "PRI-405: Médio".
