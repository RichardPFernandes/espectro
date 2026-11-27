# Fase 3 — Lugar seguro para medir

> 7 semanas · 28 dias, sem folga · 08/03 a 23/04/2027 (D14) · Status: não iniciada · Abre com a Fase 2 fechada. Frente A:
> projeto-amostra e modelo por fase (F3.2, F3.3 e a F4.2, trazida para cá; a F3.1 é feita
> na Fase 2). Frente B: contenção fina e medição de gate (F3.4 a F3.6).

**Objetivo.** Ter um projeto limpo onde rodar tickets reais sem Redmine e sem dado do
consumidor, e fechar o que falta de contenção fina.

**Por que vem aqui.** O projeto-amostra resolve volume de runs, dogfood sem dado corporativo
e regressão a cada mudança de prompt, e é pré-condição da prova de valor. Custa por rodada,
então precisa do teto da Fase 1.

## Critério de saída

- [ ] Três tickets de ouro completos, com custo registrado (a run sem Redmine é critério da Fase 2).
- [ ] Modelo por fase (F4.2): decisão registrada com n, medida nos tickets de ouro (custo por fase × primeira passada).
- [ ] Regra em uso: mudança de prompt, skill ou policy roda os três tickets antes do merge.
- [ ] Alerta de run acima de N vezes a mediana funcionando; agente encerrado por tempo em ensaio, com motivo registrado.
- [ ] Uma run de ensaio cancelada pelo operador, com o diff visível (F3.8).
- [ ] Weekly mostra gates por run, espera mediana e contagem de escalations.

## Fatias

| ID | Fatia e demonstração | Dias | Nível | AUTORIZO | Depende de | Premissa / decisão | Status | Issue no Linear |
| -- | -- | -- | -- | -- | -- | -- | -- | -- |
| F3.1 | Fonte de ticket por arquivo: agente real despachado a partir de um arquivo no formato de issue. Uma run completa sem Redmine | 5 | Médio | Não | — | Hipótese: o nó commit fecha em commit local, sem PR. D6, 16/11: feita na Fase 2, no lugar da F2.3 | não iniciada | sem issue |
| F3.2 | Projeto-amostra como segundo consumidor e primeiro ticket de ouro de ponta a ponta | 5 | Médio | Não | F3.1, F1.3 | D4: o piloto é o próprio repo do Espectro, e o projeto-amostra pode encolher; D8 | não iniciada | sem issue |
| F3.3 | Três tickets de ouro e um comando que roda os três e compara custo com a rodada anterior | 3 | Leve | Não | F3.2 | Representatividade é hipótese | não iniciada | sem issue |
| F3.4 | Alerta de run acima de N vezes a mediana, mais teto em dinheiro ou sonda da cota, conforme D1 | 3 | Alto ao ligar | Sim | F1.3, F1.5 | D1 | não iniciada | sem issue |
| F3.5 | Encerrar agente vivo por tempo, com motivo registrado (sem alarme) | 5 | Alto | Sim | F1.3 | Estimativa cortada para caber | não iniciada | sem issue |
| F3.6 | Métricas de gate no weekly: gates respondidos, espera mediana, escalations, tempo humano × máquina × espera | 2 | Leve | Não | — | Conferir a PRI-327 | não iniciada | PRI-151 |
| F3.7 | Experimento: prova de valor antecipada com três tickets de ouro tirados de issues fechadas do próprio Espectro, Espectro contra o agente direto (Claude Code com o fluxo `/pri-*` do agent-skills). Antecipa a F5.4 | 3 | Leve | Não | PRI-391 | Aprovado em 16/11. D15: roda ao lado da Fase 1, no launcher do piloto com o Redmine local, sem esperar a F3.1; o resultado decide a ordem das Fases 4 e 5. D16: desenho best-of-N e registro de intervenção (estudo Orca, PRI-422) | não iniciada | PRI-81 relacionada |
| F3.8 | Cancelar uma run pelo operador e ver o diff dela; reaproveita o encerramento da F3.5 | 3 | Alto ao ligar | Sim | F3.5 | D13 | não iniciada | sem issue |

## Semente

### F3.7 — Prova de valor antecipada

- **Intenção.** Saber cedo se o grafo com gates entrega mais do que o agente direto na mesma tarefa, antes de gastar as Fases 4 e 5 otimizando o custo de algo sem valor provado (D15).
- **Onde roda.** No launcher do piloto, no próprio Espectro, com o Redmine local da PRI-391. Não toca o consumidor corporativo e não depende da F3.1; a F3.1 continua necessária para o projeto-amostra (F3.2).
- **Não inclui.** Otimizar o resultado; mais de três tickets; ligar flag no consumidor.
- AC-01: três tickets de ouro tirados de issues já fechadas do próprio Espectro, de tamanhos diferentes (pequeno, médio, grande), com o diff mesclado como gabarito.
- AC-02: dois braços com repetição: Espectro (watcher e grafo) e agente direto (Claude Code com o fluxo `/pri-*` do agent-skills, sem watcher). Mesmo modelo de base nos dois, ou a diferença registrada.
- AC-03: medidas por braço, nesta ordem de peso: tempo do Richard por ticket (minutos de atenção: decisões, aceites e correções), retrabalho (tentativas e recusas), testes do gabarito que passam, arquivos fora do escopo, custo (as três réguas da D1) e turnos.
- AC-04: o critério de "útil" é escrito antes da primeira run e não muda depois dela.
- AC-05: o quadro é publicado com n e método mesmo se o Espectro perder, e a decisão da D15 é registrada em `DECISOES.md`.
- AC-06: os braços de um mesmo ticket correm em paralelo, cada um na sua worktree e sobre a mesma base (best-of-N; o Orca serve para rodá-los lado a lado). Um segundo braço Espectro, se couber no orçamento, usa outro checkout do launcher e mede a variância entre runs (D16).
- AC-07: cada braço registra as intervenções do Richard: no agente direto, as correções de rumo que ele fez; no Espectro, os pontos em que ele teria corrigido e não pôde, e quanto da run se perdeu depois disso. É o gatilho da F6.17 (D16).
- AC-08: uma sonda curta, no padrão de `scripts/probes/`, confere se `claude --resume` abre de forma interativa uma sessão criada por `claude -p --session-id`, com o mesmo `CLAUDE_CONFIG_DIR`. O resultado vai no quadro.
