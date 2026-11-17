# Fase 0 — Destravar

> Ao lado da Fase 1 · Status: em andamento. Itens aprovados pelo Richard em 16/11/2026 a partir
> do estudo "O que falta e como acelerar". Frente A: engenharia do repo. Frente B: fluxo e
> exposição. Nenhuma fatia toca o consumidor corporativo.

**Objetivo.** Tirar o que freia todo o resto: CI que falha sem dizer por quê, repo público
com exposição desnecessária, falta de um comando para ver o Espectro rodar e regras de fluxo
que seguram trabalho pronto.

**Por que roda em paralelo.** São fatias de nível Leve, de um a três dias, que não dependem
da Fase 1 e encurtam cada fatia seguinte. A medição que as motivou: PR leva 13 minutos de
aberto a mesclado, mas a issue espera dias pelo aceite; o CI de testes falha em 17,5% das
execuções.

## Critério de saída

- [ ] Estado atual da `main` sem caminho pessoal nem número de ticket do tracker corporativo; `SECURITY.md` e `dependabot.yml` no repo.
- [ ] O log do CI lista os testes que falharam; todo `*.test.js` roda ou está numa lista de exclusão com motivo.
- [ ] `npm run demo` na raiz roda um ciclo simulado; README com "Veja funcionando".
- [ ] Regras de fluxo aprovadas no `CLAUDE.md` e no `AGENTS.md`.
- [ ] Sonda da CLI rodada uma vez com a CLI real.

## Fatias

| ID | Fatia | Dias | Nível | AUTORIZO | Depende de | Decisão | Status | Issue no Linear |
| -- | -- | -- | -- | -- | -- | -- | -- | -- |
| F0.1 | Higiene do repo público: caminhos pessoais, tickets do tracker, `SECURITY.md`, Dependabot | 2 | Leve | Não | — | D8 | em andamento | PRI-376 (limite de issues do plano) |
| F0.2 | CI mostra qual teste falhou; lista de testes por glob | 2 | Leve | Não | — | — | em andamento | PRI-376 |
| F0.3 | Um comando na raiz e "Veja funcionando" no README | 3 | Leve | Não | — | — | em andamento | PRI-376 |
| F0.4 | Regras de fluxo no Acordo e entrada do agente mais enxuta | 1 | Leve | Não | — | D12 | em andamento | PRI-376 |
| F0.5 | (removida em 2026-11-16: a premissa caiu) Poda dos prompts dos nós | 2 | Alto | Sim | — | O preâmbulo não é idêntico nos 11 comandos e é quase todo instrução; o ganho seria de cerca de 0,5 KB em 125 KB. Um teste fixa o hash de `implement.md`, `review.md` e `commit.md` (`scripts/lib/decomposition-watcher.test.js`). Reabrir só com medição de duplicação interna | removida | PRI-376 |
| F0.6 | Sonda de fumaça da CLI contra mudança no modo `-p` | 2 | Leve | Não | — | — | em andamento | PRI-376 |
| F0.7 | ESLint só de erros no JavaScript de produção e teto de linhas nos três arquivos grandes | 2 | Leve | Não | F0.2 | — | não iniciada | sem issue |
| F0.8 | Merge automático do Leve com CI verde e lista de caminhos | 2 | Alto | Sim | F0.2, F0.4 | D12 | não iniciada | sem issue |
| F0.9 | Bloco de Estado e relatório semanal automáticos | 3 | Médio | Não | F0.4 | — | em andamento | PRI-399 |

## Sementes das fatias ainda não iniciadas

### F0.7 — ESLint de erros e teto de linhas

- **Intenção.** Uma classe inteira de erro sai da revisão: lint só de erros sobre o JavaScript de produção, com base de violações aceitas que só encolhe, e teto de linhas para o watcher, o server e o `index.html`.
- **Não inclui.** Regras de estilo; corrigir as violações existentes.
- AC-01: o lint roda no CI sobre `scripts/` e `dashboard/` e falha só em violação nova.
- AC-02: um teste falha se algum dos três arquivos grandes crescer além do teto registrado.

### F0.8 — Merge automático do Leve

- **Intenção.** PR de nível Leve com CI verde e só caminhos permitidos mescla sozinho.
- **Não inclui.** Médio e Alto; caminhos que rodam numa Run (`scripts/` de produção, `.claude/`).
- AC-01: a lista de caminhos permitidos é lida da base do PR, não do próprio PR.
- AC-02: PR que toca caminho fora da lista não mescla sozinho, mesmo rotulado como Leve.
- AC-03: um resumo diário lista o que entrou.

### F0.9 — Estado e relatório automáticos

- **Intenção.** O bloco de Estado da issue acompanha o PR sem edição manual, e o rito de segunda recebe o relatório pronto.
- **Não inclui.** Tocar "Decisão pendente", que continua manual.
- AC-01: ao abrir e ao mesclar um PR, Estado e Próximo passo da issue citada mudam sozinhos.
- AC-02: o relatório semanal traz as cinco métricas de `ACOMPANHAMENTO.md`, cada uma com n e fonte; sem medição aparece como desconhecido.
