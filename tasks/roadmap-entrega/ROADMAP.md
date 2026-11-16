# Mapa do roadmap

> Um cycle = 1 semana = 5 dias úteis de um dev. Total agendado: 21 cycles. Todo ganho de
> custo é hipótese até a F1.5: nenhum dado de run real foi lido no estudo.

## Resultados buscados

| Resultado | Métrica que prova |
| -- | -- |
| O consumidor está contido | Flags sem data de decisão = 0 (teste no CI); volta ao último verde em um comando, ensaiada; nenhuma run passa do teto sem decisão humana |
| O custo por ticket cai, com prova | Custo por ticket entregue abaixo da linha de base, com n e período, na régua de D1 |
| Menos coisa desligada | Itens construídos e desligados: 9 hoje, no máximo 5 ao fim da Fase 2, no máximo 3 ao fim da Fase 4 |

## Fases

| Fase | Objetivo | Cycles | Depende de | Status |
| -- | -- | -- | -- | -- |
| [1. Conter e enxergar](fase-1-conter-e-enxergar/FASE.md) | Registro de flags, ponto de retorno, teto por run, linha de base | 3 | — | não iniciada |
| [2. Primeira economia ligada, primeira poda](fase-2-economia-e-poda/FASE.md) | Portão de build ligado, dois pilotos decididos, código morto fora, credenciais reduzidas | 4 | Fase 1 | não iniciada |
| [3. Lugar seguro para medir](fase-3-lugar-seguro-para-medir/FASE.md) | Rodar sem Redmine, projeto-amostra com três tickets de ouro, limite de tempo | 5 | Fase 2 | não iniciada |
| [4. Segunda rodada de custo e fila única](fase-4-custo-e-fila-unica/FASE.md) | Antes/depois por flag, modelo por fase, fila "Aguardando você" com aviso | 5 | Fase 3 | não iniciada |
| [5. Custo no caso real e prova de valor](fase-5-caso-real-e-prova-de-valor/FASE.md) | Roteamento que vale para Java, Espectro × agente direto | 4 | Fase 4 | não iniciada |
| [6. Fila condicional](fase-6-fila-condicional/FASE.md) | Itens que só entram com gatilho | sem agenda | gatilho de cada item | não iniciada |

## Antes da Fase 1 (horas, não dias)

- [ ] Conferir a visibilidade do repo no GitHub e o compartilhamento do artefato do roadmap de arquitetura (D8).
- [ ] Corrigir o `README.md`: pin citado, licença e modo real de operação.
- [ ] Conferir qual pasta o launcher do consumidor usa e devolvê-la para a `main` limpa.
- [ ] Registrar três números: modelo e esforço padrão da conta, runs concluídas por semana, assinatura ou API paga.
- [ ] Triar o cycle corrente para duas frentes.
- [ ] Responder D1, D3 e D5 em [`DECISOES.md`](DECISOES.md), ou aceitar as premissas.

## Fora do roadmap agora

A decomposição não se congela (pilota na F2.2) e `docs/consumer-operations.md` não se arquiva.

| Item | Ação | Condição para retomar |
| -- | -- | -- |
| Ligar qualquer flag no consumidor | Parar até o fim da Fase 1 | F1.1 a F1.3 fechadas |
| `WATCHER_PLAN_DENY_SETTINGS`, writer de Self-SDD | Remover na F2.5 | Decisão do Richard, com chamador definido |
| Classificador Jev, verificação de UI | Congelar com data no registro de flags | Dado que justifique; F6.8 |
| Recusas de QA, cadeia plan+implement | Congelar | F6.10; F6.4 |
| Migração TypeScript, reescrita do watcher | Estacionar; extrair só o trecho tocado em cada fatia | Gargalo de manutenção medido |
| Discovery, porta de tracker e forge, abertura | Não começar | D2; D4 |
| Novos documentos de governança | Parar | Só se uma fatia exigir |
