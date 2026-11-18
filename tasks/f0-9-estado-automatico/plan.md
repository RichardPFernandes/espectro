# Plano F0.9 AC-02: Action no merge atualiza a issue

Entrada: AC-02 da PRI-399 (sem SPEC; Médio). AC-01 (#186) e AC-03 (#214) já estão mesclados; o
plano anterior, do AC-03, está no histórico do Git. Tarefas em [`todo.md`](todo.md). Um subagente
opus por tarefa, um PR só, que fecha a fatia.

> AC-02: uma Action no merge (`pull_request` fechado e mesclado) lê o "Refs PRI-NNN" e o rótulo
> `processo:*`. Em Leve e Médio, sem outro PR aberto anexado e sem filha aberta, move a issue para
> Done e atualiza Estado e Próximo passo. Alto não muda (Done só com aceite do Richard). Liga por
> variável do repo, desligada por padrão.

## Decisões de implementação

- **Lib pura + CLI com rede injetável**, no molde do `processo-lib.mjs`: `.github/scripts/estado-no-merge-lib.mjs`
  decide; `.github/scripts/estado-no-merge.mjs` fala com o Linear (GraphQL) e o GitHub por funções
  recebidas como parâmetro. Os testes passam falsos que registram as chamadas: é o que prova "Alto
  não muda" e "desligada não escreve".
- **Variável do repo `ESTADO_NO_MERGE`**: ausente ou `off`, o job nem roda (o `if` do job barra antes
  de qualquer passo, e o secret não é lido); `simular`, lê Linear e GitHub e escreve só o resumo do
  job; `on`, escreve no Linear. Nasce sem valor. Entra no `docs/flags.md` à mão (o detector não
  enxerga `.github/`), com `Onde` apontando o arquivo do workflow.
- **Uma mutação só por issue** (`issueUpdate` com `stateId` e `description` juntos): ou muda tudo, ou
  nada. Erro do Linear deixa o job vermelho, sem repetir.
- **Só as linhas `**Estado:**` e `**Próximo passo:**`** do bloco do topo são reescritas. "Decisão
  pendente", "Ligado ao fechar", "Nível" e o resto da descrição ficam como estão (fora de escopo).
  Sem a linha, a descrição não muda e o resumo diz isso.
- **Leve/Médio com outro PR aberto ou filha aberta**: não move para Done; reescreve Estado e Próximo
  passo dizendo o que falta (PR #n, filha PRI-m). Assim a issue também deixa de ficar parada.
- **"Outro PR aberto"** = anexo da issue com URL `github.com/<repo>/pull/<n>`, `n` diferente do PR
  mesclado, cujo estado na API do GitHub é `open`. **Filha aberta** = filha com `state.type` fora de
  `completed` e `canceled`. **Done** = estado do time com `type: completed` e nome `Done`.
- **Gatilhos**: `pull_request: closed` (só `merged`, base `main`, mesmo repo; PR de fork não recebe o
  secret) e `workflow_dispatch` com input `pr`. O dispatch serve para reprocessar um merge e para o
  bot da F0.8, cujo merge com `GITHUB_TOKEN` não dispara `pull_request` (risco abaixo).
- **O workflow não roda código do PR**: checkout esparso de `/.github/` da `main`, com
  `persist-credentials: false`; permissões `contents: read` e `pull-requests: read`.
- **Testes** rodam no `processo-check`, que já executa `node --test .github/scripts/*.test.mjs`. O
  `npm run test:changed` não cobre `.github/`; no build, cada tarefa roda esse comando.

## Ordem e dependências

```
T1 lib pura ── T2 CLI (Linear + GitHub injetáveis) ── T3 workflow ── T4 registro de flags e /pri-pr
```

Ponto de controle depois de T3: o merge ponta a ponta, com falsos, passa nos testes nos três modos.
No fim: `npm test` e `npm run check` na raiz verdes (o `/pri-check`).

## Riscos

| Risco | Impacto | Mitigação |
| -- | -- | -- |
| Merge do bot da F0.8 (`GITHUB_TOKEN`) não dispara `pull_request: closed` | Médio: Leve mesclado pelo bot fica parado | `workflow_dispatch` com `pr`; a F0.8 dispara este workflow como já faz com o `roadmap-pages` (uma linha de comentário na PRI-410, regra 13) |
| Edição humana da descrição entre a leitura e a escrita | Baixo: segundos de janela | Aceito; só duas linhas mudam e o histórico do Linear guarda a anterior |
| Bloco de Estado fora do formato (`**Estado:**`) | Baixo | Não reescreve; ainda move para Done se elegível; o resumo do job registra |
| Chave do Linear com escrita no CI | Médio | Secret só no `env` do passo que roda a CLI; nenhum código do PR roda no job; nunca impresso |
| PR com "Refs" de várias issues | Baixo | Cada issue é avaliada sozinha; falha numa não impede as outras, e o job fica vermelho no fim |

## Demonstração (regra 9)

No PR: testes com falsos nos três modos e uma saída de `--simular` contra um evento de exemplo,
colada na Evidência. Depois do merge, ligar é do Richard: `ESTADO_NO_MERGE=simular`, dispatch com
`pr=<este PR>` mostra a decisão no resumo do job; então `on`.

## Fora do plano

Gravar a variável, tocar "Decisão pendente", usar "Fixes", mudar a regra 10 e alterar a F0.8.
