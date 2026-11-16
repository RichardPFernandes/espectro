# Fase 1 — Conter e enxergar

> 4 cycles · 17 dias · Status: não iniciada. Frente A: contenção (F1.1 a F1.3 e F1.6). Frente B:
> linha de base (F1.4 e F1.5).

**Objetivo.** Ter as três barreiras que faltam (lista de flags, ponto de retorno, teto por
run) e a régua de custo.

**Por que vem primeiro.** Todo merge chega ao consumidor sem pin; a flag é a única barreira
e não tem lista. Nenhum agente tem limite. Sem linha de base, nenhum ganho pode ser afirmado.
As únicas coisas ligadas no consumidor corporativo nesta fase são as próprias barreiras,
nesta ordem: registro, retorno, teto. Os pilotos PRI-341 e PRI-354 rodam no launcher do
piloto, no próprio Espectro, e seguem em paralelo (D11).

## Critério de saída

- [ ] Teste no CI falha quando há flag sem data de decisão ou vencida; contagem = 0.
- [ ] Volta ao último verde feita em um comando, ensaiada uma vez; launcher recusa checkout sujo ou fora da `main`.
- [ ] Uma run de ensaio bate no teto de turnos e para com status de bloqueio.
- [ ] Push de repo irmão pulado não é mais reportado como sucesso (PRI-179).
- [ ] Capa do weekly mostra custo por ticket entregue, custo do retrabalho por nó e primeira passada por nó, com n e período.
- [ ] Meta de custo por ticket registrada (D6), ou a frase "sem meta até a semana X".

## Fatias

| ID | Fatia | Dias | Nível | AUTORIZO | Depende de | Decisão | Status | Issue no Linear |
| -- | -- | -- | -- | -- | -- | -- | -- | -- |
| F1.1 | Registro de flags | 3 | Leve | Não | — | — | não iniciada | sem issue |
| F1.2 | Ponto de retorno do consumidor | 4 | Alto | Sim | F1.1 | D3 | não iniciada | sem issue; inclui a PRI-372 (Médio); PRI-371 é a alternativa de D3 |
| F1.3 | Teto de turnos por run | 3 | Alto ao ligar | Sim | F1.1, F1.2 | D1 | não iniciada | sem issue |
| F1.4 | Linha de base: retrabalho | 2 | Leve | Não | — | D1 | não iniciada | sem issue; base é a PRI-327 (Done) |
| F1.5 | Linha de base: custo por ticket | 3 | Leve | Não | F1.4 | D1, D6 | não iniciada | sem issue; PRI-82 relacionada |
| F1.6 | Push dos repos irmãos: pulado não vira sucesso | 2 | Alto | A confirmar | — | — | não iniciada | PRI-179 (Alto, Ready) |

Com a F1.6, a fase passa de 15 para 17 dias e de 3 para 4 cycles; sobram 3 dias de folga.
Se estourar, a F1.5 escorrega para o primeiro cycle da Fase 2: ela não bloqueia a F2.1, só
a ligação dos pilotos no consumidor corporativo.

## Sementes das specs

Cada semente é o ponto de partida da spec da fatia: intenção, limite e ACs iniciais. O
desenho fica para a spec.

### F1.1 — Registro de flags

- **Intenção.** Uma tabela única no repo diz, para cada flag, a issue, o estado no consumidor, o critério de ligar e de desligar e a data de decisão.
- **Não inclui.** Ligar ou remover qualquer flag; mudar comportamento.
- AC-01: Existe uma tabela versionada com todas as flags lidas pelo código, e um teste falha se o código ler uma flag ausente da tabela.
- AC-02: O teste falha quando uma flag está sem data de decisão ou com a data vencida.
- AC-03: As cinco flags de ambiente que faltam estão no `.env.example`.
- AC-04: Cada um dos 9 itens construídos e desligados tem uma data de decisão na tabela.

### F1.2 — Ponto de retorno do consumidor

- **Intenção.** Voltar o consumidor ao último estado verde com um comando, e impedir que ele suba de um checkout sujo ou fora da `main`.
- **Não inclui.** Voltar ao pin (isso é D3); automatizar deploy.
- AC-01: Um comando único devolve o checkout do consumidor à marca de "último verde".
- AC-02: O launcher recusa subir com árvore suja ou fora da `main`, com mensagem que diz o motivo.
- AC-03: Depois de avançar a marca, uma checagem de saúde roda e o resultado fica registrado.
- AC-04: O ensaio de volta foi executado uma vez, com evidência no PR.
- AC-05: Testes em worktree não gravam no log de conflitos do checkout vivo (PRI-372).

### F1.3 — Teto de turnos por run

- **Intenção.** Nenhuma run consome sem limite: estourou o teto, ela para e espera decisão humana.
- **Não inclui.** Teto em dinheiro (F3.4); encerrar agente vivo por tempo (F3.5); otimizar o valor do teto.
- AC-01: Com a flag desligada, o argv do despacho é idêntico ao atual.
- AC-02: Com a flag ligada, cada nó é despachado com limite de turnos, e a run tem um teto acumulado entre nós.
- AC-03: Ao estourar o teto, a run fica bloqueada com um status já existente e o motivo registrado.
- AC-04: Uma run de ensaio bloqueada pelo teto aparece na evidência do PR.

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

### F1.6 — Push dos repos irmãos (PRI-179)

- **Intenção.** Um push de repo irmão que não aconteceu nunca é reportado como sucesso.
- **Não inclui.** Mudar quais repos irmãos existem ou quando o push roda; ligar flag.
- AC-01: Um teste reproduz o push de repo irmão pulado e falha no código atual.
- AC-02: Push pulado ou falho fica registrado como tal, com o motivo, nunca como sucesso.
- AC-03: A run não é reportada como concluída enquanto houver push de repo irmão pulado ou falho.
- **A conferir.** Só o título da PRI-179 foi lido: validar os ACs contra a issue antes da spec.
