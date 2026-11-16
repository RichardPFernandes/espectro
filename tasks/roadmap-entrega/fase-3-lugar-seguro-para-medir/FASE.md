# Fase 3 — Lugar seguro para medir

> 5 cycles · 23 dias · Status: não iniciada · Abre com a Fase 2 fechada. Frente A:
> projeto-amostra (F3.1 a F3.3). Frente B: contenção fina e medição de gate (F3.4 a F3.6).

**Objetivo.** Ter um projeto limpo onde rodar tickets reais sem Redmine e sem dado do
consumidor, e fechar o que falta de contenção fina.

**Por que vem aqui.** O projeto-amostra resolve volume de runs, dogfood sem dado corporativo
e regressão a cada mudança de prompt, e é pré-condição da prova de valor. Custa por rodada,
então precisa do teto da Fase 1.

## Critério de saída

- [ ] Uma run real completa num projeto sem Redmine; depois, três tickets de ouro completos, com custo registrado.
- [ ] Regra em uso: mudança de prompt, skill ou policy roda os três tickets antes do merge.
- [ ] Alerta de run acima de N vezes a mediana funcionando; agente encerrado por tempo em ensaio, com motivo registrado.
- [ ] Weekly mostra gates por run, espera mediana e contagem de escalations.

## Fatias

| ID | Fatia e demonstração | Dias | Nível | AUTORIZO | Depende de | Premissa / decisão | Status |
| -- | -- | -- | -- | -- | -- | -- | -- |
| F3.1 | Fonte de ticket por arquivo: agente real despachado a partir de um arquivo no formato de issue. Uma run completa sem Redmine | 5 | Médio | Não | — | Hipótese: o nó commit fecha em commit local, sem PR | não iniciada |
| F3.2 | Projeto-amostra como segundo consumidor e primeiro ticket de ouro de ponta a ponta | 5 | Médio | Não | F3.1, F1.3 | D4, D8 | não iniciada |
| F3.3 | Três tickets de ouro e um comando que roda os três e compara custo com a rodada anterior | 3 | Leve | Não | F3.2 | Representatividade é hipótese | não iniciada |
| F3.4 | Alerta de run acima de N vezes a mediana, mais teto em dinheiro ou sonda da cota, conforme D1 | 3 | Alto ao ligar | Sim | F1.3, F1.5 | D1 | não iniciada |
| F3.5 | Encerrar agente vivo por tempo, com motivo registrado (sem alarme) | 5 | Alto | Sim | F1.3 | Estimativa cortada para caber | não iniciada |
| F3.6 | Métricas de gate no weekly: gates respondidos, espera mediana, escalations, tempo humano × máquina × espera | 2 | Leve | Não | — | Conferir a PRI-327 | não iniciada |
