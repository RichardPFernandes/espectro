# Fase 1 — Conter e enxergar

> 6 semanas · 23 dias · 23/11/2026 a 15/01/2027 (D14) · Status: em andamento. Frente A: contenção
> (F1.1 a F1.3, F1.6, F1.8 e F1.9). Frente B: linha de base (F1.4, F1.5 e F1.7).

**Objetivo.** Ter as três barreiras que faltam (lista de flags, ponto de retorno, teto por
run) e a régua de custo.

**Por que vem primeiro.** Todo merge chega ao consumidor sem pin; a flag é a única barreira
e não tem lista. Nenhum agente tem limite. Sem linha de base, nenhum ganho pode ser afirmado.
As únicas coisas ligadas no consumidor corporativo nesta fase são as próprias barreiras,
nesta ordem: registro, retorno, teto. Os pilotos PRI-341 e PRI-354 rodam no launcher do
piloto, no próprio Espectro, e seguem em paralelo (D11).

## Critério de saída

- [x] Teste no CI falha quando há flag sem data de decisão ou vencida; contagem = 0.
- [ ] Volta ao último verde feita em um comando, ensaiada uma vez; launcher recusa checkout sujo ou fora da `main`.
- [ ] Uma run de ensaio bate no teto de turnos e para com status de bloqueio.
- [x] Push de repo irmão pulado não é mais reportado como sucesso (PRI-179).
- [ ] Capa do weekly mostra custo por ticket entregue, custo do retrabalho por nó e primeira passada por nó, com n e período.
- [x] Varredura do repo público feita, com destino para cada achado (F1.9).
- [ ] Custo lido do JSON da CLI, com versão da CLI, modelo e hash dos prompts por run (F1.5).
- [ ] Causa das recusas de QA e das rajadas de despacho identificada ou marcada como desconhecida (F1.7, F1.8).
- [ ] Meta de custo por ticket registrada (D6), ou a frase "sem meta até a semana X".

## Fatias

| ID | Fatia | Dias | Nível | AUTORIZO | Depende de | Decisão | Status | Issue no Linear |
| -- | -- | -- | -- | -- | -- | -- | -- | -- |
| F1.1 | Registro de flags | 3 | Leve | Não | — | — | concluída | PRI-377 |
| F1.2 | Ponto de retorno do consumidor | 4 | Alto | Sim | F1.1 | D3 | em andamento | PRI-379; inclui a PRI-372 |
| F1.3 | Teto de turnos por run; inclui parar depois de N falhas seguidas do mesmo nó ([`DADOS.md`](../DADOS.md), item 6) | 3 | Alto ao ligar | Sim | F1.1, F1.2 | D1 | não iniciada | PRI-380; a PRI-392 (defeito do state-writer) é feita junto |
| F1.4 | Linha de base: retrabalho | 2 | Leve | Não | — | D1 | concluída | PRI-378; base é a PRI-327 (Done) |
| F1.5 | Linha de base: custo por ticket | 3 | Médio | Não | F1.4 | D1, D6 | concluída | PRI-381; PRI-82 relacionada; reclassificada de Leve para Médio em 17/11 (D-PRI-381-01, na Mesa de Decisões), o 1º PR foi Leve |
| F1.6 | Push dos repos irmãos: pulado não vira sucesso | 2 | Alto | Sim | — | — | concluída | PRI-179 |
| F1.7 | Causa das recusas de QA: as recusas repetem causa? É a metade da F5.3 que não espera a Fase 5 | 2 | Leve | Não | — | D13 | não iniciada | sem issue; PRI-86 relacionada |
| F1.8 | Causa das falhas de despacho em rajada ([`DADOS.md`](../DADOS.md), item 6), só leitura | 2 | Leve | Não | — | D13 | concluída | PRI-407 |
| F1.9 | Varredura de dado do consumidor no repo público: estado atual e histórico do Git | 2 | Leve | Não | — | D8 | concluída | PRI-401 |

Com a F1.6 e as fatias F1.7 a F1.9, a fase soma 23 dias. Cada semana conta 4 dias de fatia
(D14), o que dá 6 semanas, com 1 dia de folga. A F1.9 é feita primeiro (D8). Se estourar, a F1.5 escorrega para a primeira semana
da Fase 2: ela não bloqueia a F2.1, só
a ligação dos pilotos no consumidor corporativo.

## Sementes das specs

Cada semente é o ponto de partida da spec da fatia: intenção, limite e ACs iniciais. O
desenho fica para a spec.

### F1.1 — Registro de flags

- **Intenção.** Uma tabela única no repo diz, para cada flag, a issue, o estado no consumidor, o critério de ligar e de desligar e a data de decisão.
- **Não inclui.** Ligar ou remover qualquer flag; mudar comportamento.
- AC-01: Existe uma tabela versionada com todas as flags lidas pelo código, e um teste falha se o código ler uma flag ausente da tabela.
- AC-02: O teste falha quando uma flag está sem data de decisão ou com a data vencida.
- AC-03: Toda variável de ambiente lida pelo código está no `.env.example` (um estudo contou 50 fora dele), e as que o exemplo lista sem leitura no código saem ou ganham justificativa.
- AC-04: Cada um dos 9 itens construídos e desligados tem uma data de decisão na tabela.

### F1.2 — Ponto de retorno do consumidor

- **Intenção.** Voltar o consumidor ao último estado verde com um comando, e impedir que ele suba de um checkout sujo ou fora da `main`.
- **Não inclui.** Voltar ao pin (isso é D3); automatizar deploy.
- AC-01: Um comando único devolve o checkout do consumidor à marca de "último verde".
- AC-02: O launcher recusa subir com árvore suja ou fora da `main`, com mensagem que diz o motivo.
- AC-03: Depois de avançar a marca, uma checagem de saúde roda e o resultado fica registrado.
- AC-04: O ensaio de volta foi executado uma vez, com evidência no PR; a marca de "último verde" é uma tag anotada (hoje não há tag, release nem changelog).
- AC-05: Testes em worktree não gravam no log de conflitos do checkout vivo (PRI-372).

### F1.3 — Teto de turnos por run

- **Intenção.** Nenhuma run consome sem limite: estourou o teto, ela para e espera decisão humana.
- **Não inclui.** Teto em dinheiro (F3.4); encerrar agente vivo por tempo (F3.5); otimizar o valor do teto.
- AC-01: Com a flag desligada, o argv do despacho é idêntico ao atual.
- AC-02: Com a flag ligada, cada nó é despachado com limite de turnos, e a run tem um teto acumulado entre nós.
- AC-03: Ao estourar o teto, a run fica bloqueada com um status já existente e o motivo registrado.
- AC-04: Uma run de ensaio bloqueada pelo teto aparece na evidência do PR.
- AC-05: Quando o nó falha por limite de uso da conta, o teto não conta essa falha como
  tentativa, e o despacho espera o reset que a CLI informa (ou um intervalo fixo, se faltar),
  em vez de parar a run. O release lê a cauda do log, como o DOM-06 já faz, e reconhece as
  três mensagens de limite ("session", "5 horas", "semanal"); a espera vale para toda a conta,
  não só para a run. Origem: [`DADOS.md`](../DADOS.md#falhas-de-despacho-em-rajada-causa-f18)
  (F1.8): 779 das 786 saídas com código 1 eram limite de uso, e as três maiores rajadas (148,
  103 e 95 erros) terminaram sozinhas no minuto do reset. Mesma região de código e mesma flag
  da F1.3 (Alto ao ligar).

### F1.4 — Linha de base: retrabalho

- **Intenção.** A capa do weekly mostra quanto custa o retrabalho e quanto passa de primeira, por nó.
- **Não inclui.** Custo por ticket (F1.5); qualquer mudança no despacho. Parte do weekly entregue na PRI-327.
- AC-01: A capa mostra custo do retrabalho por nó e primeira passada por nó, com n e período.
- AC-02: Todo valor em USD traz o rótulo "imputado"; tokens e tempo de parede aparecem ao lado.
- AC-03: Modelo e esforço padrão da conta e runs concluídas por semana estão registrados no relatório.

### F1.5 — Linha de base: custo por ticket

- **Intenção.** Saber quanto custa um ticket entregue, somando as recusas de QA, e acompanhar isso toda semana.
- **Não inclui.** Comparação por flag (F4.1); meta automática.
- AC-01: O weekly mostra custo por ticket entregue somando recusas de QA, com n e período, nas três réguas.
- AC-02: Ausência de dado aparece como desconhecido, nunca como zero.
- AC-03: A série semanal tem pelo menos um ponto registrado.
- AC-04: O custo vem do JSON que a CLI devolve; o leitor de transcript fica como reserva, e a diferença entre os dois aparece no relatório.
- AC-05: Cada run registra a versão da CLI, o modelo de cada nó e o hash dos prompts dos nós, para o antes e depois não misturar configurações.

### F1.6 — Push dos repos irmãos (PRI-179)

- **Intenção.** Um push de repo irmão que não aconteceu nunca é reportado como sucesso.
- **Não inclui.** Mudar quais repos irmãos existem ou quando o push roda; ligar flag.
- AC-01: A chave de deduplicação do push inclui a identidade do repositório; o mesmo push em dois repos gera dois efeitos.
- AC-02: Repetição idêntica no mesmo repo continua deduplicada.
- AC-03: Push que falha não é reportado como entrega bem-sucedida.
- AC-04: Os testes usam repositórios temporários ou transporte falso, sem push real.

### F1.7 — Causa das recusas de QA

- **Intenção.** Saber se as recusas de QA repetem causa, antes de decidir a F6.10. Dado de 16/11: run com recusa custa quase cinco vezes a mediana.
- **Não inclui.** Mudar o ciclo de recusas; publicar diagnóstico; copiar texto do consumidor.
- AC-01: Um quadro agregado mostra as recusas por causa, com n e período, sem ticket, nome ou texto do consumidor.
- AC-02: O quadro diz se a F6.10 sai da fila condicional. Amostra insuficiente aparece como desconhecido.

### F1.8 — Causa das falhas de despacho

- **Intenção.** Saber por que houve centenas de saídas com código 1 em poucos segundos e se a queda nas semanas 44 a 46 veio de correção.
- **Não inclui.** Corrigir; o limite de falhas seguidas é da F1.3.
- AC-01: A causa de cada rajada está identificada ou marcada como desconhecida, com a evidência lida.
- AC-02: O resultado diz se a F1.3 basta ou se falta uma fatia de correção.

### F1.9 — Varredura do repo público

- **Intenção.** O repo é público de propósito (D8). Saber o que do consumidor está exposto, no estado atual e no histórico, e decidir o que fazer com cada achado.
- **Não inclui.** Reescrever o histórico do Git: se a varredura achar algo que peça isso, vira decisão do Richard.
- AC-01: a varredura cobre a `main`, todos os commits alcançáveis e o texto dos PRs, procurando credencial, dado de ticket e nome ou caminho interno do consumidor.
- AC-02: cada achado tem destino: removido do estado atual, aceito com motivo ou levado ao Richard. Credencial achada é tratada como vazada e trocada.
- AC-03: o relatório no PR traz só contagens e caminhos, sem repetir o dado exposto.
