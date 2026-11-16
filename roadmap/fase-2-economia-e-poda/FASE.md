# Fase 2 — Primeira economia ligada, primeira poda

> 4 cycles · 18 dias · Status: não iniciada · Abre com a Fase 1 fechada, menos os
> pilotos F2.2 e F2.3, em andamento em paralelo (D11). Frente A: custo, ligar e decidir
> (F2.1 a F2.3). Frente B: reduzir superfície (F2.4 a F2.6).

**Objetivo.** Ligar a primeira mudança que reduz custo de uma run comum, decidir os dois
pilotos mais próximos e tirar do repo o que não tem chamador nem ganho.

**Um piloto por vez, nesta ordem:** decomposição, depois esforço por fase (como na PRI-354).
Os dois rodam no launcher do piloto, no próprio Espectro, em paralelo com a Fase 1 (D11). No
consumidor corporativo, o portão de build liga primeiro, com uma semana para refazer a linha
de base. Cada piloto tem teto de runs e data; no vencimento, liga de vez ou remove.

## Critério de saída

- [ ] Portão de build ligado no consumidor; reprovações de review ou test por erro de compilação perto de zero nas runs seguintes.
- [ ] Decomposição: decisão ligar/remover registrada com n. Esforço por fase: decisão registrada, ou piloto em curso com data de fim.
- [ ] Removidos: `WATCHER_PLAN_DENY_SETTINGS`, rota `coordination`, esqueleto `scripts/src`. Writer de Self-SDD mantido, com data no registro de flags (D5).
- [x] dependency-cruiser roda em PR; a contagem de violações não sobe de 77 (já entregue: `scripts/architecture-boundaries.test.js`).
- [ ] Teste prova que chave do Redmine e token do Bitbucket não chegam ao processo do agente, e o ciclo ticket → PR segue funcionando.
- [ ] Itens desligados: de 9 para no máximo 6.

## Fatias

| ID | Fatia e demonstração | Dias | Nível | AUTORIZO | Depende de | Premissa / decisão | Status | Issue no Linear |
| -- | -- | -- | -- | -- | -- | -- | -- | -- |
| F2.1 | Portão de build antes do review: compilar, lint e teste dirigido depois do implement; falhou, volta ao implement sem abrir review. Termina ligado | 4 | Alto ao ligar | Sim | Fase 1 | Tamanho do ganho é hipótese; a F1.4 dá o antes | não iniciada | sem issue; PRI-208 vizinha |
| F2.2 | Piloto de decomposição: PR que liga, 3 a 5 runs, quadro antes/depois, decisão ligar ou remover | 3 | Alto | Sim | PRI-335, PRI-374. Para ligar no consumidor corporativo: F1.3, F1.5, F2.1 estabilizada | D11: roda no launcher do piloto, em paralelo com a Fase 1. Teto: 5 runs ou 2 semanas (D6) | em andamento | PRI-341 (em andamento, AUTORIZO dado); pré-requisitos: PRI-335 (Alto, Ready) e PRI-374 (Médio, Ready) |
| F2.3 | Piloto de esforço por fase (PRI-354): ligar com data, medir custo, tempo e reprovação tardia, decidir | 2 | Alto | Sim | F2.2 decidida | Só liga sabendo o esforço padrão da conta; pode gastar mais. D11: no launcher do piloto; a flag só liga com a F2.2 decidida. Teto: 10 pares de runs (PRI-354) ou 3 semanas | em andamento | PRI-354 (em andamento, AUTORIZO dado em 15/11) |
| F2.4 | dependency-cruiser em PR, com as 77 violações como base; falha só nas novas | 2 | Leve | Não | PRI-359 | Conferido em 16/11: já estava entregue antes do roadmap, em `scripts/architecture-boundaries.test.js` | concluída | sem issue; PRI-359 (Leve) é pré-requisito |
| F2.5 | Poda: remover a flag de `permissions.deny`, a rota `coordination`, `scripts/src` e a casca de TypeScript que só o cobre; Jev e writer de Self-SDD ficam, com data no registro | 3 | Médio | Não | F2.4 | D5: o writer de Self-SDD não sai; PRI-349 e filhas dão a ele um chamador. Remover só por decisão do Richard | não iniciada | PRI-315 (Done); conflita com PRI-349 e filhas |
| F2.6 | Credenciais fora do shell do agente, por lista de permissão; teste + um ciclo ticket → PR completo | 4 | Alto | Sim | Fase 1 | Solução e esforço são hipótese | não iniciada | sem issue; PRI-316 vizinha |
