# Fase 3 — Lugar seguro para medir

> 7 semanas · 25 dias · 08/03 a 23/04/2027 (D14) · Status: não iniciada · Abre com a Fase 2 fechada. Frente A:
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
| F3.7 | Experimento: prova de valor antecipada com três tickets de ouro tirados de issues fechadas, Espectro contra o agente direto. Antecipa a F5.4 | 3 | Leve | Não | F3.1 | Aprovado em 16/11; resultado pode reordenar as Fases 4 e 5 | não iniciada | PRI-81 relacionada |
| F3.8 | Cancelar uma run pelo operador e ver o diff dela; reaproveita o encerramento da F3.5 | 3 | Alto ao ligar | Sim | F3.5 | D13 | não iniciada | sem issue |

## Semente

### F3.7 — Prova de valor antecipada

- **Intenção.** Saber cedo se o grafo com gates entrega mais do que o agente direto na mesma tarefa.
- **Não inclui.** Otimizar o resultado; mais de três tickets.
- AC-01: três tickets de ouro tirados de issues já fechadas, com o diff mesclado como gabarito.
- AC-02: dois braços (Espectro e agente direto), com repetição, medindo testes do gabarito, arquivos fora do escopo, custo e turnos.
- AC-03: o quadro é publicado mesmo se o Espectro perder.
