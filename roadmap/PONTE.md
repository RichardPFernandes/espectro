# Tabela-ponte: design e arquitetura no roadmap de entrega

> F0.10 (D13), retrato de 17/11/2026. O canvas de design do dashboard e o roadmap de
> arquitetura não ficam neste repo. O destino de cada linha foi dado pelo título da página ou
> da macrofase, sem conferir tela por tela nem card por card. Se o conteúdo disser outra coisa,
> corrija a linha.

O canvas e o roadmap de arquitetura descrevem muito mais do que está na fila. Esta tabela diz,
linha por linha, o que deles já é fatia, o que espera um gatilho e o que é só visão. Ela não
cria fatia nem move issue: fatias e status moram no `FASE.md` de cada fase, e os vínculos
fatia ↔ issue em [`LINEAR.md`](LINEAR.md).

## Como ler

Cada linha tem um destino, e só um.

| Destino | Quando vale |
| -- | -- |
| na fatia Fx.y | Uma fatia das Fases 0 a 5 entrega a linha ou um recorte dela. A nota diz o recorte e o que fica de fora |
| Fase 6 com gatilho (F6.n) | Está na [fila condicional](fase-6-fila-condicional/FASE.md): só começa com o gatilho da fatia |
| visão, sem agenda | Nenhuma fatia entrega. "Vizinha" na nota aponta uma fatia de tema próximo, que não desenha a página nem cumpre a macrofase |

Atualize a linha no mesmo PR que cria, fecha ou remove a fatia citada.

## Páginas do canvas de design

2 páginas em fatia, 2 na Fase 6 com gatilho e 11 só visão.

| Página | Destino | Issue no Linear | Nota |
| -- | -- | -- | -- |
| Visão geral e fundações | visão, sem agenda | PRI-250 | — |
| Decision Center | visão, sem agenda | PRI-253 | Decision Center está estacionado em [`LINEAR.md`](LINEAR.md). A parte de ação humana da PRI-253 está na linha "Operação e ação humana" |
| Produto do projeto | visão, sem agenda | PRI-258 | — |
| Suporte e atendimento | visão, sem agenda | PRI-259 | — |
| Operação e ação humana | na fatia F4.4 e F4.5 | PRI-252, PRI-253, PRI-173, PRI-129 | Recorte: fila "Aguardando você", só leitura (D7), com idade, motivo e link. Vizinhas: F3.8 (cancelar run), F6.7 a F6.9. O resto da página não tem fatia |
| Painel de projetos | visão, sem agenda | PRI-257 | Vizinha: F6.11 (PRI-133), que espera a D4 |
| Providers, modelos e plataforma | visão, sem agenda | PRI-256 | Vizinhas: F4.2 (modelo por fase), F5.1 e F5.2 (roteamento em sombra e ligado), sem tela |
| Infraestrutura e DevOps | visão, sem agenda | PRI-260 | — |
| Governança e segurança | visão, sem agenda | PRI-254 | Vizinhas: F4.3 (dashboard preso a loopback) e F6.7 (aprovador identificado) |
| Specs, SDD e conhecimento | visão, sem agenda | PRI-255 | Vizinhas: F0.16 abre `docs/` no Obsidian (absorveu a F6.13) e F6.14 exporta para um vault, não para uma tela |
| Home, notificações e relatórios | na fatia F4.5, F4.6 e F3.6 | PRI-251, PRI-151 | Recorte: a fila vira a tela inicial (F4.5), aviso por webhook e resumo diário (F4.6), métricas de gate no weekly (F3.6). Vizinha: F1.5 (custo por ticket no weekly). A PRI-251 também cita onboarding, que não tem fatia |
| Skills — avaliação e evolução | Fase 6 com gatilho (F6.12) | PRI-346, PRI-344, PRI-299 | Gatilho: PRI-299 e PRI-344 autorizadas |
| Capabilities — histórico de mudanças | visão, sem agenda | PRI-356 | Vizinha: o writer de Self-SDD (PRI-349), que fica congelado (D5, F2.5) |
| Arquivo da auditoria | visão, sem agenda | sem issue | — |
| UNKNOWN e lacunas | Fase 6 com gatilho (F6.16) | PRI-369, PRI-367, PRI-368 | Gatilho: revisão de 15/01/2027 (D5) |

As 11 issues "Design · … — planejar implementação" de PRI-250 a PRI-260 estão nas linhas
acima. A PRI-261 (Design · Mobile) não corresponde a uma página desta lista: visão, sem agenda.

## Macrofases do roadmap de arquitetura

8 linhas em fatia, 1 na Fase 6 com gatilho e 8 só visão. Os itens estacionados (PARKED) têm
uma linha cada.

| Macrofase | Destino | Issue no Linear | Nota |
| -- | -- | -- | -- |
| MP-00 base (tasks 1–60) | visão, sem agenda | sem issue | Nenhuma fatia certifica a base; o [`README.md`](../README.md) registra que a extração não certifica MP-00 |
| MP-01 SDD V2 Core (61–85) | visão, sem agenda | PRI-349 | O writer de Self-SDD fica congelado até a Fase 2 fechar (D5, F2.5). A spec viva (F0.11 a F0.14) é do desenvolvimento do Espectro, não desta macrofase |
| MP-02 eventos, human gate, policy, recovery | na fatia F1.3, F3.5, F3.8 e F4.4 | PRI-380, PRI-253, PRI-173, PRI-129 | Recorte: teto por run (F1.3), encerrar e cancelar run (F3.5, F3.8), fila de espera humana (F4.4). Eventos e recovery de run não têm fatia. Vizinha: F1.2 |
| MP-03 segurança (threat model, segredos, identidade) | na fatia F2.6 e F4.3 | sem issue; PRI-316 vizinha | Recorte: modelo de ameaça de uma página e credenciais fora do shell (F2.6), dashboard preso a loopback (F4.3). Identidade: F6.7, com gatilho (D7) |
| MP-04 resultados estruturados e taxonomia de falha | na fatia F1.7, F1.8 e F2.8 | PRI-86 relacionada | Recorte: causa das recusas de QA e das falhas de despacho, só leitura (F1.7, F1.8), e recibo da run (F2.8). A taxonomia como contrato não tem fatia. Vizinha: F6.16 |
| MP-05 workflow portável (manifesto, contexto, definição) | na fatia F2.7 | PRI-394 | Recorte: a definição, com `graph.yaml` como única fonte de nós e arestas. Manifesto e contexto não têm fatia |
| MP-06 abstração de integrações (tracker, forge, CI) | na fatia F3.1 | PRI-96, PRI-133 (da F6.11) | Recorte: fonte de ticket por arquivo (F3.1). A porta de tracker e forge é a F6.11, com gatilho (D4). CI não tem fatia |
| MP-07 abstração de provider | visão, sem agenda | sem issue | Vizinha: F4.2 troca o modelo por fase, não o provider |
| MP-08 desacoplamento do engine e bootstrap | visão, sem agenda | sem issue | A reescrita do watcher está estacionada no [`ROADMAP.md`](../ROADMAP.md): extrai-se só o trecho tocado em cada fatia. Vizinha: F3.2 (segundo consumidor) |
| MP-09 control plane e configuração | visão, sem agenda | sem issue | Vizinhas: F1.1 (registro de flags, concluída) e F4.1 (coortes por configuração) |
| MP-10 dashboard (inspector, needs attention, live run) | na fatia F4.4 e F4.5 | PRI-253, PRI-173, PRI-129 | Recorte: needs attention, como a fila "Aguardando você". Inspector e live run (PRI-242) não têm fatia |
| MP-11 ciclo de vida de dados | visão, sem agenda | sem issue | — |
| MP-12 evals e versionamento do pipeline | na fatia F1.5, F3.3 e F4.1 | PRI-381 | Recorte: versão da CLI, modelo e hash dos prompts por run (F1.5), tickets de ouro com comparação entre rodadas (F3.3), coortes por configuração (F4.1). Vizinhas: F5.4 e F6.12 |
| PARKED · scheduler | visão, sem agenda | sem issue | — |
| PARKED · idempotência de gatilho | visão, sem agenda | sem issue | — |
| PARKED · kill switch | na fatia F3.5 e F3.8 | sem issue | Recorte por run: encerrar por tempo (F3.5) e cancelar pelo operador (F3.8). Um interruptor global não tem fatia |
| PARKED · adapters secundários | Fase 6 com gatilho (F6.11) | PRI-96, PRI-133 | Gatilho: a D4 nomear um usuário externo |
