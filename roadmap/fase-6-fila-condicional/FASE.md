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
| F6.10 | Ciclo de recusas de QA | a definir | Alto | Sim | F1.5 | Linha de base mostrar recusas repetidas pela mesma causa. Dado de 16/11: run com recusa custa quase 5 vezes a mediana; causa ainda não medida (F5.3) | não iniciada | PRI-275 a 280, PRI-86 |
| F6.11 | Porta de tracker e forge; preparação da abertura | a definir | Alto | Sim | F3.1, F2.4, F2.5 | D4 nomear um usuário externo | não iniciada | PRI-96, PRI-133 |
| F6.12 | Skills por nó e benchmark | a definir | Alto | Sim | F3.3, F4.1 | PRI-299 e PRI-344 autorizadas | não iniciada | PRI-299, PRI-300 e filhas, PRI-344, PRI-346 |
