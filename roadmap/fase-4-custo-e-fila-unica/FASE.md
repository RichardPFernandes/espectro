# Fase 4 — Segunda rodada de custo e fila única

> 5 cycles · 23 dias · Status: não iniciada · Abre com a Fase 3 fechada. Frente A: custo
> (F4.1 e F4.2). Frente B: decisão humana (F4.3 a F4.6).

**Objetivo.** Dar a cada flag ligada um antes/depois automático, pilotar modelo por fase e
juntar num lugar tudo que espera o Richard.

**Por que vem aqui.** Modelo por fase depende do comparador por coorte e do projeto-amostra
para o primeiro teste. A fila única vem agora porque a F3.6 passa a dizer se o gate é mesmo
o gargalo.

## Critério de saída

- [ ] Toda flag ligada tem quadro antes/depois com n, gerado pelo comparador.
- [ ] Modelo por fase: decisão registrada com n (custo por fase × primeira passada).
- [ ] Dashboard recusa subir fora de loopback.
- [ ] 100% dos estados que esperam humano aparecem na fila e disparam webhook com link; espera mediana menor que a medida na F3.6.

## Fatias

| ID | Fatia e demonstração | Dias | Nível | AUTORIZO | Depende de | Premissa / decisão | Status | Issue no Linear |
| -- | -- | -- | -- | -- | -- | -- | -- | -- |
| F4.1 | Coortes por configuração no comparador, só para flags do registro; refaz o quadro do portão de build e da decomposição | 5 | Médio | Não | F1.1, F1.5 | — | não iniciada | sem issue |
| F4.2 | Modelo por fase: tabela fase → modelo atrás de flag; primeiro nos tickets de ouro, depois piloto no consumidor | 4 | Alto ao ligar | Sim (consumidor) | F4.1, F3.3 | D1: em "dinheiro" sobe para a Fase 2. Dado de 16/11: implement é 43 % do custo e roda no modelo mais caro | não iniciada | PRI-352 e filhas |
| F4.3 | Dashboard preso a loopback e proteção contra requisição forjada conferida | 3 | Médio | Não | — | D7 | não iniciada | sem issue |
| F4.4 | Fila "Aguardando você": todo estado que espera humano, só leitura | 5 | Alto ao ligar | Sim | F4.3 | D7, D9 | não iniciada | PRI-253, PRI-173, PRI-129 |
| F4.5 | Idade, motivo e link direto em cada item; a fila vira a tela inicial | 3 | Médio | Não | F4.4 | Tela nova só com dado | não iniciada | sem issue |
| F4.6 | Webhook para todo estado de espera, com link, e resumo diário | 3 | Alto ao ligar | Sim | F3.6 | — | não iniciada | sem issue |
