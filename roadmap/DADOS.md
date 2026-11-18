# Dados reais de runs: o que o roadmap passou a saber

> Leitura de 16/11/2026 sobre o histórico de runs do primeiro consumidor. Só agregados:
> nenhum ticket, nome ou conteúdo de run entra aqui. Substitui as suposições de
> [`BASE.md`](BASE.md) onde os dois divergirem. É a medição à mão que a F1.5 vai automatizar.

## De onde vem e o que não é

- Fonte: arquivos de custo e de estado por run, lidos sem alterar nada. Runs documentais
  ficaram de fora.
- Amostra: 45 tarefas com custo; 44 runs com estado; 25 com contadores de retry; 24 com
  eventos (só da semana 40 em diante); 17 com tentativa a tentativa.
- USD é **imputado** pelo preço de tabela, não desembolso. Vale para comparar, não para
  cobrar.
- Amostra pequena e de um consumidor só. Diferença entre grupos é pista, não prova.

## Números

| Tema | Medida | Valor |
| -- | -- | -- |
| Custo por tarefa | mediana · p75 · p90 · máximo (n = 45) | 13,9 · 29,6 · 48,4 · 166,8 USD |
| Concentração | parte do custo nas 5 e nas 10 tarefas mais caras | 40 % · 57 % |
| Custo por ticket entregue | mediana (n = 19) · custo total dividido pelos entregues | 24,1 USD · cerca de 58 USD |
| Tempo de agente por tarefa | mediana · p75 · p90 | 64 · 120 · 196 min |
| Do início à última atualização, entregues | mediana · p75 | 18,7 h · 92,6 h |
| Custo por nó | implement · review · plan · test · commit · verify | 43 · 15 · 14 · 13 · 8 · 7 % |
| Tempo por nó | implement · test · review · plan · verify · commit | 35 · 30 · 12 · 9 · 8 · 6 % |
| Cache | parte lida do cache nos tokens de entrada, todos os nós | 95 a 98 % |
| Cache | primeiro turno frio | só no plan (62 % das tentativas pagas) |
| Modelo | uso por nó | o modelo mais caro em 233 de 283 usos |
| Primeira passada | runs sem retry em review, test e verify (n = 25) | 12 de 25 |
| Retry por nó | runs sem retry: review · test · verify (n = 25) | 15 · 21 · 19 |
| Plano | tentativas extras de plano · nota mediana | 0 · 100 |
| Despacho repetido | custo além da primeira tentativa paga de cada nó (n = 17) | 66 % (teto do retrabalho; inclui retomada legítima) |
| Retry declarado | custo das tentativas com causa "retry" (n = 17) | cerca de 12 % |
| Recusa de QA | custo mediano com recusa (n = 8) × sem (n = 11) | 35,0 × 7,4 USD |
| Falha de despacho | erros de nó · com código de saída 1 · em menos de 30 s | 361 · 354 · 340 |
| Falha de despacho | maior sequência sem um nó concluir | 148 |
| Falha de despacho | erros por início de nó: semanas 41–43 × 44–46 | 74 % × 19 % |
| Pré-build | mediana · passou (n = 14) | 18 s · 13 de 14 |
| Volume | tickets iniciados por semana, últimas 6 semanas | 1 a 4 |

## O que muda no roadmap

1. **Cache não é alavanca.** A F6.1 pedia medir; está medido. Recomendação: não atacar.
2. **O implement é o custo (43 %) e roda no modelo mais caro.** A F4.2 (modelo por fase) é
   a maior alavanca de dinheiro à vista. Pesa na D1.
3. **O test é o tempo (30 %) com 13 % do custo.** Se a D1 for "tempo", o alvo é o test, não
   o `--follow` da F6.3.
4. **Recusa de QA é o retrabalho mais caro que se enxerga:** quase cinco vezes o custo
   mediano. A F6.10 tem o gatilho de custo; falta saber se as causas se repetem. Essa
   pergunta entra na F1.7 (antecipada da F5.3 em 17/11, D13).
5. **O plano não é o problema:** nota 100, zero replano. E a nota não separa run cara de
   barata, então a metade "plan-score prevê retrabalho" da F5.3 tem pouca chance.
6. **Falha de despacho em rajada:** centenas de saídas com código 1 em cinco segundos, sem
   custo, concentradas em três runs e nas semanas 41 a 43; caiu depois. A F1.3 ganha um
   critério: parar depois de N falhas seguidas do mesmo nó. Causa lida em 18/11 (F1.8):
   limite de uso da conta do Claude Code, sem correção no Git; ver
   [Falhas de despacho em rajada](#falhas-de-despacho-em-rajada-causa-f18). Os números
   daquela seção valem no lugar dos desta linha.
7. **Volume baixo:** a condição da D6 (menos de 5 runs concluídas por semana) é o caso
   real. Com esse volume, piloto no consumidor leva semanas para juntar amostra; o
   projeto-amostra da F3.1 vale mais cedo.

## Reordenação aprovada pelo Richard em 16/11

- F3.1 é feita na Fase 2 no lugar da F2.3 (D6).
- F4.2 é feita na Fase 3, logo depois da F3.3, sem esperar a F4.1 (D1): com volume baixo,
  as coortes da F4.1 não juntam amostra no consumidor.
- F6.1 removida (medida). F6.10 sai da fila condicional se a F1.7 achar causa repetida.
- Os IDs não mudam: a fatia fica na linha do `FASE.md` de origem, com a nota de onde é feita.

## Falhas de despacho em rajada: causa (F1.8)

> Leitura de 18/11/2026, só leitura, só agregados. Fontes: eventos de nó (`node_error`,
> `node_start`) dos `state.json` e linhas `[claude]` do log de despacho de cada run, do
> primeiro consumidor, mais o histórico do Git do Prisma. Nenhum ticket, nome ou texto do
> consumidor entra aqui; do log só se contou a presença de mensagens genéricas do CLI.

**Causa (AC-01): limite de uso da conta do Claude Code.** Das 786 saídas de nó com código 1
(14 runs, de 07/10 a 16/11), 779 (99 %) trazem, nos 20 s antes do erro, a mensagem de limite
da conta: "session" 611, "5 horas" 161, "semanal" 7. As 7 restantes ficam sem causa
(desconhecido). O agente morre em cerca de 5 s (mediana) e não gasta: as 353 tentativas
registradas no custo com menos de 10 s somam 0,00 USD.

**Por que vira rajada.** Quando a saída traz o limite, o watcher só registra o aviso e deixa
o próximo tick tentar de novo (`dispatchTicket`, bloco `looksUnavailable`). Não há teto nem
espera: o mesmo nó é redespachado a cada 79 s (mediana de 738 intervalos; tick de 60 s mais
o agente falhando) até a janela abrir. As três maiores rajadas (148, 103 e 95 erros em 2 a
3,5 h, todas no nó `test`) terminam no minuto do reset que a própria mensagem informa (−1,
−1 e 0 min). Foram 27 rajadas de 3 ou mais erros (erros separados por menos de 15 min); as
outras 23 param antes do reset, e o que as interrompeu não está nos arquivos lidos
(desconhecido). Três runs concentram 68 % dos erros
(541 de 786). Dois runs diferentes falharam nos mesmos minutos mais de uma vez: a causa é da
conta, não do run.

| Semana ISO | Inícios de nó | Erros com código 1 | Com mensagem de limite |
| -- | -- | -- | -- |
| 41 (05/10) | 37 | 27 | 27 |
| 42 (12/10) | 339 | 279 | 279 |
| 43 (19/10) | 385 | 294 | 292 |
| 44 (26/10) | 68 | 20 | 20 |
| 45 (02/11) | 167 | 84 | 81 |
| 46 (09/11) | 121 | 81 | 79 |
| 47 (16/11, parcial) | 47 | 1 | 1 |

**A queda veio de correção? Não achei.** O bloco que trata o limite nasceu na extração
(5a41c43, 06/10) e nenhum commit seguinte muda esse comportamento; `git log -S` do texto e a
busca por espera, cooldown ou contagem de falhas seguidas no watcher não acham nada. Os
commits do período 19/10 a 16/11 tratam de roteamento, QA, dashboard e DOM-06, não de saída
com erro. A queda também é parcial: 79 % dos inícios de nó terminaram em erro nas semanas 41
a 43, 52 % nas semanas 44 a 46 (as semanas 45 e 46 têm mais quatro rajadas) e 2 % na
semana 47. O que fez o limite ser atingido menos vezes (menos uso, outro plano da conta,
roteamento de modelo) é **desconhecido**: está fora dos arquivos lidos. Limite desta
leitura: só o Git do Prisma foi lido, não o checkout vivo do consumidor.

**Divergência com a leitura de 16/11.** Esta leitura conta 786 saídas com código 1 e 79 % ×
52 % de erros por início de nó; a de 16/11 registrou 354 e 74 % × 19 %. Não sei o filtro
daquela. Valem estes números, refeitos por eventos únicos de nó (sem duplicar cópias do
mesmo run). A causa e a forma da rajada não mudam.

**A F1.3 basta? (AC-02) Contém, mas não cura: falta um critério.**

- Parar depois de N falhas seguidas do mesmo nó corta cada rajada de 148 para N. Isso é o
  que a Fase 1 precisa (conter).
- Só que a rajada era autorrecuperável: as três maiores terminaram sozinhas no reset. Com o
  teto da F1.3, cada run pararia em N e esperaria uma retomada manual por um problema que se
  resolve em horas. Os runs em paralelo também continuariam gastando N cada um, pois o teto é
  por run e a causa é da conta.
- O sinal já existe: `operationalCause` devolve `PROVIDER_UNAVAILABLE` e o DOM-06 já isenta
  essa causa do teto (`EXEMPT_CAUSES` em `dom06-attempt.js`); falta o despacho comum fazer o
  mesmo.
- Recomendação: não abrir fatia nova. Acrescentar à F1.3 um critério: saída com limite de uso
  não conta no teto e segura o despacho de toda a conta até o horário de reset informado na
  mensagem (ou um intervalo fixo, se faltar). Mesma região de código e mesma flag da F1.3
  (Alto ao ligar). Decisão do Richard: é mudança de escopo da F1.3.
