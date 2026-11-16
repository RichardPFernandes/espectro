# Roadmap de entrega do Espectro

> **Status:** PROPOSTA de 15/11/2026, aguardando aprovação do Richard. Estrutura, regras e
> decisões: [`roadmap/`](roadmap/README.md).

> A coluna Cycles conta semanas de trabalho (5 dias úteis de um dev), não cycles do Linear,
> que têm 14 dias. Total agendado: 22 semanas. A ordem foi revista em
> 16/11 com dados reais de runs ([`roadmap/DADOS.md`](roadmap/DADOS.md)); tamanho de ganho segue
> hipótese até a F1.5 medir de forma contínua. Semanas são
> relativas: S1 é o primeiro cycle depois do cycle corrente.

## Resultados buscados

| Resultado | Métrica que prova |
| -- | -- |
| O consumidor está contido | Flags sem data de decisão = 0 (teste no CI); volta ao último verde em um comando, ensaiada; nenhuma run passa do teto sem decisão humana |
| O custo por ticket cai, com prova | Custo por ticket entregue abaixo da linha de base, com n e período, na régua de D1 |
| Menos coisa desligada | Itens construídos e desligados: 9 hoje, no máximo 6 ao fim da Fase 2, no máximo 4 ao fim da Fase 4 |

## Fases

| Fase | Objetivo | Cycles | Semanas | Depende de | Status |
| -- | -- | -- | -- | -- | -- |
| [0. Destravar](roadmap/fase-0-destravar/FASE.md) | CI legível, exposição do repo tratada, um comando para ver rodar, regras de fluxo | ao lado | S1–S3 | — | em andamento |
| [1. Conter e enxergar](roadmap/fase-1-conter-e-enxergar/FASE.md) | Registro de flags, ponto de retorno, teto por run, push dos repos irmãos, linha de base | 4 | S1–S4 | — | não iniciada |
| [2. Primeira economia ligada, primeira poda](roadmap/fase-2-economia-e-poda/FASE.md) | Portão de build ligado, piloto de decomposição decidido, run sem Redmine (F3.1), código morto fora, credenciais reduzidas | 4 | S5–S8 | Fase 1; o piloto F2.2 segue em paralelo (D11) | não iniciada; F2.2 em andamento |
| [3. Lugar seguro para medir](roadmap/fase-3-lugar-seguro-para-medir/FASE.md) | Projeto-amostra com três tickets de ouro, modelo por fase decidido neles (F4.2), limite de tempo | 5 | S9–S13 | Fase 2 | não iniciada |
| [4. Segunda rodada de custo e fila única](roadmap/fase-4-custo-e-fila-unica/FASE.md) | Antes/depois por flag, modelo por fase no consumidor se aprovado, fila "Aguardando você" com aviso | 5 | S14–S18 | Fase 3 | não iniciada |
| [5. Custo no caso real e prova de valor](roadmap/fase-5-caso-real-e-prova-de-valor/FASE.md) | Roteamento que vale para Java, Espectro × agente direto | 4 | S19–S22 | Fase 4 | não iniciada |
| [6. Fila condicional](roadmap/fase-6-fila-condicional/FASE.md) | Itens que só entram com gatilho | sem agenda | — | gatilho de cada item | não iniciada |

## Antes da Fase 1 (horas, não dias)

- [ ] Conferir a visibilidade do repo no GitHub e o compartilhamento do artefato do roadmap de arquitetura (D8).
- [ ] Corrigir o `README.md`: pin citado, licença e modo real de operação.
- [ ] Conferir qual pasta o launcher do consumidor usa e devolvê-la para a `main` limpa.
- [ ] Registrar três números: modelo e esforço padrão da conta, runs concluídas por semana, assinatura ou API paga.
- [ ] Triar o cycle corrente para duas frentes.
- [ ] Responder D1, D3, D5 e D8 em [`DECISOES.md`](roadmap/DECISOES.md), ou aceitar as premissas.

## Fora do roadmap agora

| Item | Ação | Condição para retomar |
| -- | -- | -- |
| Ligar qualquer flag no consumidor corporativo (app-back) | Parar até o fim da Fase 1. Não vale para o launcher do piloto no próprio Espectro: PRI-341 e PRI-354 seguem em paralelo (D11) | F1.1 a F1.3 fechadas |
| `WATCHER_PLAN_DENY_SETTINGS` | Remover na F2.5: medido sem ganho | Nova medição, por decisão do Richard |
| Writer de Self-SDD (PRI-349 e filhas) | Manter o código; tirar as issues do cycle até a Fase 2 fechar | D5 |
| Classificador Jev, verificação de UI | Congelar com data no registro de flags | Dado que justifique; F6.8 |
| Recusas de QA, cadeia plan+implement (a decomposição não se congela: pilota na F2.2) | Congelar | F6.10; F6.4 |
| Migração TypeScript, reescrita do watcher | Estacionar; extrair só o trecho tocado em cada fatia | Gargalo de manutenção medido |
| Discovery, porta de tracker e forge, abertura | Não começar | D2; D4 |
| Novos documentos de governança | Parar | Só se uma fatia exigir |
