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
   pergunta entra na F5.3.
5. **O plano não é o problema:** nota 100, zero replano. E a nota não separa run cara de
   barata, então a metade "plan-score prevê retrabalho" da F5.3 tem pouca chance.
6. **Falha de despacho em rajada:** centenas de saídas com código 1 em cinco segundos, sem
   custo, concentradas em três runs e nas semanas 41 a 43; caiu depois. Não verificado: a
   causa e se a queda veio de correção. A F1.3 ganha um critério: parar depois de N falhas
   seguidas do mesmo nó.
7. **Volume baixo:** a condição da D6 (menos de 5 runs concluídas por semana) é o caso
   real. Com esse volume, piloto no consumidor leva semanas para juntar amostra; o
   projeto-amostra da F3.1 vale mais cedo.

## Reordenação recomendada (aguarda o Richard)

- F3.1 entra na Fase 2 no lugar da F2.3, como a D6 já previa.
- F4.2 sobe para logo depois da F3.1 e da F3.3, sem esperar a F4.1: com volume baixo, as
  coortes da F4.1 não juntam amostra no consumidor.
- F6.1 sai da fila (medida). F6.10 sai da fila condicional se a F5.3 achar causa repetida.
- A ordem dos IDs não muda até a decisão; só as notas das fatias apontam para cá.
