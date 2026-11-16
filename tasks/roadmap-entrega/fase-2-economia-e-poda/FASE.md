# Fase 2 — Primeira economia ligada, primeira poda

> 4 cycles · 18 dias · Status: não iniciada · Abre com a Fase 1 fechada. Frente A: custo,
> ligar e decidir (F2.1 a F2.3). Frente B: reduzir superfície (F2.4 a F2.6).

**Objetivo.** Ligar a primeira mudança que reduz custo de uma run comum, decidir os dois
pilotos mais próximos e tirar do repo o que não tem chamador nem ganho.

**Um piloto por vez, nesta ordem:** portão de build ligado, uma semana para refazer a linha
de base, decomposição, esforço por fase. Cada piloto tem teto de runs e data; no vencimento,
liga de vez ou remove.

## Critério de saída

- [ ] Portão de build ligado no consumidor; reprovações de review ou test por erro de compilação perto de zero nas runs seguintes.
- [ ] Decomposição: decisão ligar/remover registrada com n. Esforço por fase: decisão registrada, ou piloto em curso com data de fim.
- [ ] Removidos: `WATCHER_PLAN_DENY_SETTINGS`, writer de Self-SDD, rota `coordination`, esqueleto `scripts/src`.
- [ ] dependency-cruiser roda em PR; a contagem de violações não sobe de 77.
- [ ] Teste prova que chave do Redmine e token do Bitbucket não chegam ao processo do agente, e o ciclo ticket → PR segue funcionando.
- [ ] Itens desligados: de 9 para no máximo 5.

## Fatias

| ID | Fatia e demonstração | Dias | Nível | AUTORIZO | Depende de | Premissa / decisão | Status |
| -- | -- | -- | -- | -- | -- | -- | -- |
| F2.1 | Portão de build antes do review: compilar, lint e teste dirigido depois do implement; falhou, volta ao implement sem abrir review. Termina ligado | 4 | Alto ao ligar | Sim | Fase 1 | Tamanho do ganho é hipótese; a F1.4 dá o antes | não iniciada |
| F2.2 | Piloto de decomposição: PR que liga, 3 a 5 runs, quadro antes/depois, decisão ligar ou remover | 3 | Alto | Sim | F1.3, F1.5, F2.1 estabilizada | Teto: 5 runs ou 2 semanas (D6) | não iniciada |
| F2.3 | Piloto de esforço por fase (PRI-354): ligar com data, medir custo, tempo e reprovação tardia, decidir | 2 | Alto | Sim | F2.2 decidida | Só liga sabendo o esforço padrão da conta; pode gastar mais. Teto: 15 runs ou 3 semanas | não iniciada |
| F2.4 | dependency-cruiser em PR, com as 77 violações como base; falha só nas novas | 2 | Leve | Não | — | — | não iniciada |
| F2.5 | Poda: remover a flag de `permissions.deny`, o writer de Self-SDD, a rota `coordination` e `scripts/src`; Jev congelado com data | 3 | Médio | Não | F2.4 | D5 | não iniciada |
| F2.6 | Credenciais fora do shell do agente, por lista de permissão; teste + um ciclo ticket → PR completo | 4 | Alto | Sim | Fase 1 | Solução e esforço são hipótese | não iniciada |
