# Fase 4 — Segunda rodada de custo e fila única

> 5 semanas · 19 dias · 26/04 a 28/05/2027 (D14) · Status: não iniciada · Abre com a Fase 3 fechada. Frente A: custo
> (F4.1; a F4.2 é feita na Fase 3). Frente B: decisão humana (F4.3 a F4.6).

**Objetivo.** Dar a cada flag ligada um antes/depois automático, levar o modelo por fase ao
consumidor se os tickets de ouro aprovarem, e juntar num lugar tudo que espera o Richard.

**Depende do resultado da F3.7 (D15).** Se o Espectro não ganhar do agente direto em
nenhuma medida que pesa, esta fase é revista antes de abrir.

**Por que vem aqui.** Decidido em 16/11 (D1): o modelo por fase não espera o comparador por
coorte, porque com o volume real as coortes não juntam amostra no consumidor; o primeiro
teste é nos tickets de ouro, na Fase 3. A fila única vem agora porque a F3.6 passa a dizer se o gate é mesmo
o gargalo.

## Critério de saída

- [ ] Toda flag ligada tem quadro antes/depois com n, gerado pelo comparador.
- [ ] Modelo por fase: se aprovado na Fase 3, piloto no consumidor com quadro antes/depois do comparador.
- [ ] Dashboard recusa subir fora de loopback.
- [ ] 100% dos estados que esperam humano aparecem na fila e disparam webhook com link; espera mediana menor que a medida na F3.6.

## Fatias

| ID | Fatia e demonstração | Dias | Nível | AUTORIZO | Depende de | Premissa / decisão | Status | Issue no Linear |
| -- | -- | -- | -- | -- | -- | -- | -- | -- |
| F4.1 | Coortes por configuração no comparador, só para flags do registro; refaz o quadro do portão de build e da decomposição | 5 | Médio | Não | F1.1, F1.5 | — | não iniciada | sem issue |
| F4.2 | Modelo por fase: tabela fase → modelo atrás de flag; primeiro nos tickets de ouro, depois piloto no consumidor | 4 | Alto ao ligar | Sim (consumidor) | F3.3 | D1, 16/11: feita na Fase 3, logo depois da F3.3, sem esperar a F4.1; o piloto no consumidor usa o comparador quando existir. Dado: implement é 43 % do custo e roda no modelo mais caro | não iniciada | PRI-352 e filhas |
| F4.3 | Dashboard preso a loopback e proteção contra requisição forjada conferida | 3 | Médio | Não | — | D7 | não iniciada | sem issue |
| F4.4 | Fila "Aguardando você": todo estado que espera humano, só leitura | 5 | Alto ao ligar | Sim | F4.3 | D7, D9 | não iniciada | PRI-253, PRI-173, PRI-129 |
| F4.5 | Idade, motivo e link direto em cada item; a fila vira a tela inicial | 3 | Médio | Não | F4.4 | Tela nova só com dado | não iniciada | sem issue |
| F4.6 | Webhook para todo estado de espera, com link, e resumo diário | 3 | Alto ao ligar | Sim | F3.6 | — | não iniciada | sem issue |
