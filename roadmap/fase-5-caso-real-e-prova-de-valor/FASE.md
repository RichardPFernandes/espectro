# Fase 5 — Custo no caso real e prova de valor

> 5 semanas · 18 dias · 31/05 a 02/07/2027 (D14) · Status: não iniciada · Abre com a Fase 4 fechada. Frente A: custo no
> caso real (F5.1 a F5.3). Frente B: prova de valor (F5.4 e F5.5).

**Objetivo.** Fazer o roteamento valer para o único consumidor (Java) e ter o primeiro
quadro Espectro × agente direto.

**Por que vem aqui.** A correção do viés `.java` só compensa depois que modelo por fase
mostrar quanto do ganho já foi capturado. A prova de valor precisa do projeto-amostra e de
uma linha de base madura.

## Critério de saída

- [ ] Proporção de tickets Java classificados fora de `EXCLUDED_SCHEMA` medida; roteamento capaz de rebaixar no consumidor, ou decisão de aposentar o roteamento por classe.
- [ ] Decisão com n sobre terceira tentativa e plan-score.
- [ ] Um quadro Espectro × agente direto, com método escrito e n.

## Fatias

| ID | Fatia e demonstração | Dias | Nível | AUTORIZO | Depende de | Premissa / decisão | Status | Issue no Linear |
| -- | -- | -- | -- | -- | -- | -- | -- | -- |
| F5.1 | Reconciliar o classificador e rodar em sombra para trabalho Java (PRI-318) | 4 | Médio | Não | F1.5 | Reavaliar antes: se a F4.2 já entregou o ganho, a frente encolhe | não iniciada | PRI-318 |
| F5.2 | Recalibrar e ligar o roteamento no consumidor | 4 | Alto | Sim | F5.1 | Um piloto por vez | não iniciada | sem issue |
| F5.3 | Análise de retries: quantas runs a terceira tentativa salva; se o plan-score prevê retrabalho (dado de 16/11: improvável, a nota é 100 em quase tudo); a causa das recusas de QA vem da F1.7 | 2 | Leve (Alto se mudar limite) | Só se mudar limite | F1.5 | — | não iniciada | sem issue |
| F5.4 | Método e harness da prova de valor: mesmos tickets de ouro no Espectro e no agente direto (PRI-81) | 5 | Médio | Não | F3.3, F1.5 | Desenho é hipótese | não iniciada | PRI-81, PRI-76 |
| F5.5 | Rodar e publicar o quadro: custo, tempo humano, resultado | 3 | Leve | Não | F5.4 | — | não iniciada | sem issue |
