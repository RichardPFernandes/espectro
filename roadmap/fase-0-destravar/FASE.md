# Fase 0 — Destravar

> Ao lado da Fase 1 · Status: em andamento. Itens aprovados pelo Richard em 16/11/2026 a partir
> do estudo "O que falta e como acelerar". Frente A: engenharia do repo. Frente B: fluxo e
> exposição; desde 17/11 (D5), inclui a spec viva do Espectro amarrada ao fluxo `/pri-*` (F0.11 a
> F0.14). Nenhuma fatia toca o consumidor corporativo.

**Objetivo.** Tirar o que freia todo o resto: CI que falha sem dizer por quê, repo público
com exposição desnecessária, falta de um comando para ver o Espectro rodar e regras de fluxo
que seguram trabalho pronto.

**Capacidade.** A fase soma cerca de 26 dias de fatias sem data. Elas usam o que sobra da
semana e nunca passam na frente da F1.2 e da F1.3; na frente B, a ordem é F0.11, F0.12, F0.13.

**Por que roda em paralelo.** São fatias de nível Leve, de um a três dias, que não dependem
da Fase 1 e encurtam cada fatia seguinte. A medição que as motivou: PR leva 13 minutos de
aberto a mesclado, mas a issue espera dias pelo aceite; o CI de testes falha em 17,5% das
execuções.

## Critério de saída

- [x] Estado atual da `main` sem caminho pessoal nem número de ticket do tracker corporativo; `SECURITY.md` e `dependabot.yml` no repo.
- [x] O log do CI lista os testes que falharam; todo `*.test.js` roda ou está numa lista de exclusão com motivo.
- [x] `npm run demo` na raiz roda um ciclo simulado; README com "Veja funcionando".
- [x] Regras de fluxo aprovadas no `CLAUDE.md` e no `AGENTS.md`.
- [x] Sonda da CLI rodada uma vez com a CLI real.
- [x] Uma fatia real passou pelo `/pri-*` abrindo pela spec viva e fechando com ela atualizada (F0.11 a F0.13); `tasks/` só com o que está em curso (F0.14).
- [x] Tabela-ponte publicada: cada página do canvas de design e cada macrofase da arquitetura tem um destino (F0.10).
- [x] Conhecimento durável: a fatia que muda uma capacidade `sem-spec` faz nascer a spec viva dela no mesmo PR, e a decisão de arquitetura tomada vira ADR em `docs/adr/` (F0.15).

## Fatias

| ID | Fatia | Dias | Nível | AUTORIZO | Depende de | Decisão | Status | Issue no Linear |
| -- | -- | -- | -- | -- | -- | -- | -- | -- |
| F0.1 | Higiene do repo público: caminhos pessoais, tickets do tracker, `SECURITY.md`, Dependabot | 2 | Leve | Não | — | D8 | concluída | PRI-376 (limite de issues do plano); PRI-405 (Médio, testes e prompts) |
| F0.2 | CI mostra qual teste falhou; lista de testes por glob | 2 | Leve | Não | — | — | concluída | PRI-376 |
| F0.3 | Um comando na raiz e "Veja funcionando" no README | 3 | Leve | Não | — | — | concluída | PRI-376 |
| F0.4 | Regras de fluxo no Acordo e entrada do agente mais enxuta | 1 | Leve | Não | — | D12 | concluída | PRI-376 |
| F0.5 | (removida em 2026-11-16: a premissa caiu) Poda dos prompts dos nós | 2 | Alto | Sim | — | O preâmbulo não é idêntico nos 11 comandos e é quase todo instrução; o ganho seria de cerca de 0,5 KB em 125 KB. Um teste fixa o hash de `implement.md`, `review.md` e `commit.md` (`scripts/lib/decomposition-watcher.test.js`). Reabrir só com medição de duplicação interna | removida | PRI-376 |
| F0.6 | Sonda de fumaça da CLI contra mudança no modo `-p` | 2 | Leve | Não | — | — | concluída | PRI-376 |
| F0.7 | ESLint só de erros no JavaScript de produção e teto de linhas nos três arquivos grandes | 2 | Leve | Não | F0.2 | — | concluída | PRI-406 |
| F0.8 | Merge automático do Leve com CI verde e lista de caminhos | 2 | Alto | Sim | F0.2, F0.4 | D12 | concluída | PRI-410 |
| F0.9 | Bloco de Estado e relatório semanal automáticos | 3 | Médio | Não | F0.4 | — | em andamento | PRI-399 |
| F0.10 | Tabela-ponte: uma linha por página do canvas de design e por macrofase do roadmap de arquitetura, dizendo se está numa fatia, na Fase 6 com gatilho ou é só visão | 1 | Leve | Não | — | D13 | concluída | PRI-403 |
| F0.11 | Mapa de capacidades: uma página de entrada, um arquivo por capacidade e todo arquivo de código com dono (C1 da spec viva) | 2 | Leve | Não | — | D5 | concluída | PRI-396 |
| F0.12 | Três specs vivas completas (`spec`, `grafo`, `estado`), seção "Delta de capacidade" no modelo de SPEC e aviso no `processo-check` (C2) | 3 | Leve | Não | F0.11 | D5 | concluída | PRI-402 |
| F0.13 | Fluxo `/pri-*` amarrado à spec viva: a fatia abre pela capacidade, a mudança traz o delta e o PR só sai com a spec viva conferida | 2 | Leve | Não | F0.4, F0.12 | D5 | concluída | PRI-409 |
| F0.14 | Arrumar a casa: `tasks/` de issue fechada para `docs/historico/`, `docs/prisma/` marcado como histórico e uma só descrição do fluxo de desenvolvimento (C3) | 1 | Leve | Não | F0.11 | D5 | concluída | PRI-411 |
| F0.15 | Conhecimento durável: a spec viva nasce na primeira fatia que muda a capacidade `sem-spec`, e a decisão de arquitetura vira ADR (sem tipo RFC) | 2 | Leve | Não | F0.13 | D5 | concluída | PRI-412 |

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

### F0.12 — Specs vivas e delta

- **Intenção.** As capacidades em obra têm spec viva de uma página, e toda mudança de comportamento chega como delta sobre ela.
- **Não inclui.** Escrever a spec de todas as capacidades; a de cada uma nasce quando uma mudança a toca.
- AC-01: `spec`, `grafo` e `estado` têm propósito, requisitos com ID estável, invariantes e flags em `docs/capacidades/`.
- AC-02: o modelo de SPEC de fatia tem a seção "Delta de capacidade" (Adicionado, Modificado, Removido).
- AC-03: um PR de teste que muda código de uma capacidade sem tocar a spec dela recebe o aviso do `processo-check`.

### F0.13 — Fluxo `/pri-*` amarrado à spec viva

- **Intenção.** Desenvolver o Espectro passa a ser SDD de ponta a ponta: a spec viva é lida no começo e atualizada no fim de cada fatia, sem depender de lembrar.
- **Não inclui.** Os comandos do produto em `.claude/commands/`; o writer de Self-SDD; qualquer coisa que rode numa Run.
- AC-01: o `/pri-start` lista as capacidades que a issue toca, aponta a spec viva de cada uma e grava a lista no contexto da sessão.
- AC-02: no Médio e no Alto, a SPEC da fatia traz o delta de capacidade; no Leve, o delta vai no corpo do PR.
- AC-03: o brief do revisor no `/pri-check` leva a spec viva e o delta, e ele aponta comportamento mudado sem spec atualizada.
- AC-04: o `/pri-pr` põe na Evidência uma linha por capacidade tocada, com a spec viva atualizada ou o motivo de não mudar.
- AC-05: o `processo-check` avisa, sem reprovar, quando um AC da SPEC alterada no PR não aparece na Evidência.

### F0.14 — Arrumar a casa

- **Intenção.** `tasks/` só com o que está em curso e uma só descrição do fluxo de desenvolvimento.
- **Não inclui.** Mover código; apagar histórico.
- AC-01: pastas de `tasks/` de issue fechada estão em `docs/historico/`, como já foi feito com a PRI-233; `docs/prisma/` está marcado como histórico.
- AC-02: `AGENTS.md`, `README.md` e as skills descrevem o mesmo fluxo de desenvolvimento, sem contradição.

### F0.15 — Conhecimento durável

- **Intenção.** O que uma fatia decide e muda fica num lugar durável e achável: a spec viva cobre a capacidade tocada e a decisão de arquitetura vira ADR. Em 18/11, F1.2, F1.6 e F0.9 mudaram comportamento em capacidade `sem-spec` e nenhuma spec viva nasceu.
- **Não inclui.** Escrever de uma vez as 13 specs que faltam; criar o tipo RFC (a SPEC Alto e as propostas da Mesa fazem esse papel); mudar `.claude/commands/` ou qualquer coisa que rode numa Run.
- AC-01: a F0.15 está nesta página, com linha na tabela, semente e critério de saída ajustado; o `roadmap-lint` fica verde.
- AC-02: mudança de comportamento em capacidade `sem-spec` faz nascer a spec viva dela (uma página, no molde das três existentes) no mesmo PR; o `/pri-start` avisa, o revisor do `/pri-check` cobra e o `processo-check` avisa.
- AC-03: `docs/adr/` existe, com README, modelo curto e de 5 a 8 decisões já tomadas, cada uma citando a fonte.
- AC-04: o `/pri-pr` pergunta se a fatia tomou decisão de arquitetura; se tomou, o ADR entra no PR, e a Evidência traz a linha "ADR: número ou nenhum".
- AC-05: `AGENTS.md`, `CLAUDE.md` e `docs/fluxo-dev.md` dizem em uma linha onde mora cada coisa: SPEC da fatia, spec viva, ADR e `DECISOES.md`.
