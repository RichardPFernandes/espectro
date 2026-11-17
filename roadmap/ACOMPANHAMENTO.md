# Acompanhamento semanal

> Cinco métricas, um rito de 30 minutos na segunda e uma série para preencher. Enquanto uma
> métrica não é medida, anote "sem medição", nunca zero. Por que estas métricas:
> [`BASE.md`](BASE.md).

## As cinco métricas

| # | Métrica | Onde já é medida | O que falta | Fatia que destrava |
| -- | -- | -- | -- | -- |
| 1 | Custo por ticket entregue (USD imputado e tokens), com n | Relatório semanal do dashboard: custo por ticket entregue, somando recusas de QA; o "Copiar resumo" traz a linha da série | Custo pelo JSON da CLI e versão da CLI e hash dos prompts por run (F1.5 AC-04 e AC-05) | F1.5 |
| 2 | Primeira passada e custo do retrabalho por nó | O weekly mostra primeira passada por run e retries por nó | Custo do retrabalho; levar à capa | F1.4 |
| 3 | Runs bloqueadas pelo teto e runs acima de N vezes a mediana | Não medida | Teto de turnos; alerta de anomalia | F1.3 e F3.4 |
| 4 | Estoque desligado: flags por estado, flags vencidas, itens construídos e desligados (9 em 15/11) | Não medida | Registro de flags; até lá, contar à mão | F1.1 |
| 5 | Fluxo: frentes ativas, issues abertas × fechadas, escopo do cycle no início × no fim | Linear, à mão | Nada; registrar toda segunda | — |

- A partir da F3.6 entram no mesmo quadro: gates por run e espera mediana.
- Se as métricas M1–M4 do Acordo v2 já cobrirem alguma destas, use a M e não crie outra.
- Metas ligadas a estas métricas: itens desligados em no máximo 6 ao fim da Fase 2 e no
  máximo 4 ao fim da Fase 4; issues em andamento em no máximo duas frentes.

## Rito semanal (30 min, segunda)

1. Ler as cinco métricas e anotar uma linha na série abaixo.
2. Passar o registro de flags: o que venceu liga ou morre hoje.
3. Fechar o cycle: o que não terminou volta para a fila, não rola sozinho.
4. Abrir o cycle com no máximo duas frentes e as fatias da vez. Conferir: o cycle fecha mais
   do que abre?
5. Se houver piloto em curso: quantas runs, quanto falta, data de decisão.

## Série semanal

Uma linha por semana, a mais recente embaixo. Custo sempre com n e período. Só números
agregados: nenhum ticket, nome ou conteúdo de run do consumidor entra aqui.

| Semana | Custo por ticket entregue | Primeira passada | Runs bloqueadas pelo teto | Itens desligados | Frentes ativas | Nota |
| -- | -- | -- | -- | -- | -- | -- |
| EXEMPLO DE FORMATO (apagar) AAAA-MM-DD | — USD imputado · — tokens (n = —) | — % (n = —) | — de — | — | — | Uma frase: o que mudou e por quê |
| 2026-11-16 (linha de base, todo o histórico) | 24,1 USD imputado, mediana (n = 19); tokens sem medição | 48 % sem retry em review, test e verify (n = 25) | sem medição | 9 (contado em 15/11) | sem medição | Primeira leitura à mão dos dados reais; detalhes em [`DADOS.md`](DADOS.md) |
| | | | | | | |

Como preencher:

- Métrica ainda sem fatia entregue: escreva "sem medição".
- "Runs bloqueadas pelo teto" só tem valor depois da F1.3; "Itens desligados" é contado à
  mão até a F1.1.
- Piloto em curso vai na nota: qual flag, quantas runs, data de decisão.
