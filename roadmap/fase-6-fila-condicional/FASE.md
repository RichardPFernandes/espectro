# Fase 6 — Fila condicional

> Sem agenda · Status: não iniciada. Nada aqui começa sem o gatilho. No máximo duas frentes
> por vez, em fatias de até 5 dias. Item puxado ganha pasta própria e passa a seguir as
> regras das outras fases.

| ID | Fatia | Dias (1ª fatia) | Nível | AUTORIZO | Depende de | Gatilho | Status | Issue no Linear |
| -- | -- | -- | -- | -- | -- | -- | -- | -- |
| F6.1 | (removida em 2026-11-16: medido, cache não é alavanca) Prefixo e cache por nó: medir `cache_read` do primeiro turno e decidir se ataca | 2 | Leve | Não | F1.5 | Medido em 16/11: 95 a 98 % lido do cache, primeiro turno frio só no plan. Decisão: não atacar | removida | sem issue |
| F6.2 | Pular ou enxugar nós por classe | 5 | Alto ao ligar | Sim | F5.2 | Classe confiável depois da F5.2; D1 = dinheiro | não iniciada | sem issue |
| F6.3 | `--follow` no launcher | 2 | Alto | Sim | F1.2 | D1 = tempo | não iniciada | sem issue |
| F6.4 | Piloto da cadeia plan+implement, ou remoção | 2 | Alto | Sim | F2.3 | Validade: fim da Fase 4. Sem piloto até lá, remove | não iniciada | sem issue |
| F6.5 | Re-review só do delta | 5 | Alto ao ligar | Sim | F5.3 | F5.3 mostrar que o retrabalho pesa | não iniciada | sem issue |
| F6.6 | Evitar despacho quando falta pouco da cota | 3 | Alto ao ligar | Sim | F3.4 | D1 = assinatura e a sonda da F3.4 achar o dado | não iniciada | sem issue |
| F6.7 | Aprovador identificado em toda rota de decisão; botões de aceite de spec e plano | 5 + 5 | Alto | Sim | F4.4 | D7 = dashboard vira o canal | não iniciada | sem issue |
| F6.8 | Gate de verificação manual com preview, screenshot e log | 5 | Alto | Sim | F4.4 | PRI-295 aprovada | não iniciada | PRI-295 |
| F6.9 | Dossiê de escalation | 4 | Médio | Não | F3.6, F4.4 | F3.6 mostrar escalations frequentes | não iniciada | sem issue |
| F6.10 | Ciclo de recusas de QA | a definir | Alto | Sim | F1.5 | Linha de base mostrar recusas repetidas pela mesma causa. Dado de 16/11: run com recusa custa quase 5 vezes a mediana; a causa é medida na F1.7 | não iniciada | PRI-275 a 280, PRI-86 |
| F6.11 | Porta de tracker e forge; preparação da abertura | a definir | Alto | Sim | F3.1, F2.4, F2.5 | D4 nomear um usuário externo | não iniciada | PRI-96, PRI-133 |
| F6.12 | Skills por nó e benchmark | a definir | Alto | Sim | F3.3, F4.1 | PRI-299 e PRI-344 autorizadas | não iniciada | PRI-299, PRI-300 e filhas, PRI-344, PRI-346 |
| F6.13 | Lente da spec viva: exportador do Obsidian organizado por capacidade (C4) | 2 | Médio | Não | — | F0.11 e F0.12 feitas e o Richard abrir o vault atual uma vez | removida em 2026-11-18: absorvida pela F0.16 (PRI-413) | sem issue |
| F6.14 | Exportação para um vault do Obsidian, além do PR aberto; a F6.13 é a parte dela organizada por capacidade | a definir | Médio | Não | — | D5: revisão em 15/01/2027 | não iniciada | PRI-373, PRI-73 |
| F6.15 | Verificação de UI: ligar, corrigir falsos negativos e publicar o veredito | a definir | Alto | Sim | — | D5: revisão em 15/01/2027; PRI-360 e PRI-361 fecham o PR aberto antes | não iniciada | PRI-370, PRI-390, PRI-362 |
| F6.16 | UNKNOWN: estados do ledger, medição do piloto e tela de lacunas. As fatias dessa investigação passam a se chamar U-F1 a U-F6, para não colidir com os IDs deste mapa | a definir | Leve | Não | — | D5: revisão em 15/01/2027; a PRI-366 termina antes | não iniciada | PRI-367, PRI-368, PRI-369 |
