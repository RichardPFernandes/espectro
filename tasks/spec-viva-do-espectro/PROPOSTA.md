# Proposta: spec viva do Espectro, por capacidade

> **Status:** fatias C1 a C4 aprovadas pelo Richard em 16/11/2026 (D-SDD-02). P2, P3 e P4 seguem
> sem resposta. Este arquivo é o mapa das fatias. SPEC da C1: [`SPEC-c1-mapa.md`](SPEC-c1-mapa.md),
> issue PRI-396. As outras SPECs nascem quando cada fatia começar.
> **Origem:** pedido do Richard em 16/11 ("não entendo o sistema, não consigo navegar no
> conhecimento"). Base: quatro estudos do mesmo dia (arquitetura atual, SDD no mercado,
> arquitetura alvo, Obsidian). Código lido em `main` `73a5dba`.

## O problema, em números

- 141 arquivos `.md` (16.333 linhas), pelo menos 10 pontos de entrada, nenhum mapa por capacidade.
- `tasks/` tem 53 arquivos por tarefa, sem índice nem status. Spec por tarefa vira arquivo morto.
- A explicação mais fiel do sistema está nos comentários de um arquivo de 6.212 linhas.
- `scripts/lib` tem 114 arquivos soltos, sem subpasta.
- Três vocabulários se sobrepõem (produto, extração, processo). "Gate", "spec" e "SDD" têm dois ou três sentidos.
- Não dá para saber o que está ligado: 58 variáveis de ambiente, três convenções de valor.

## O que proponho

Três peças, todas em markdown versionado no repo e legíveis no GitHub.

1. **Mapa.** `docs/capacidades/README.md` é a página única de entrada. Uma linha por
   capacidade: o que faz, situação (ligada, atrás de flag, desligada, sem chamador), flags,
   link para a spec, pasta do código. No topo: o que o Espectro faz em dez linhas, o fluxo de
   uma Run do ticket ao PR e um glossário com um sentido por palavra.
2. **Spec viva por capacidade.** `docs/capacidades/<id>.md`, uma página cada: propósito,
   vocabulário, comportamento em requisitos com ID estável, invariantes, flags, o que o
   módulo expõe, decisões ligadas. Diz comportamento e porquê; não repete o código. O
   cabeçalho (frontmatter) lista `modulos`, `testes`, `flags`, `decisoes`, `issues`.
3. **Mudança como delta.** A SPEC de uma fatia ganha a seção "Delta de capacidade"
   (Adicionado, Modificado, Removido). O PR que muda comportamento atualiza a spec viva no
   mesmo PR. A SPEC da fatia é descartável depois do merge; a spec viva fica.

O que mantém isso honesto, sem depender de disciplina:

- Teste: todo arquivo de `scripts/` e `dashboard/` pertence a exatamente uma capacidade.
- Teste: link quebrado em `docs/capacidades/` reprova.
- Teste: o que a spec lista como exposto bate com os exports do `index.js` do módulo (quando o módulo tiver pasta).
- `processo-check`: avisa quando um PR muda código de uma capacidade e não toca a spec dela.

## O que não proponho, e por quê

| Opção | Por que não |
| -- | -- |
| Usar `memory/spec/` + `index.yaml` (formato do consumidor) | No consumidor, `memory/` é local e fora do git (`.claude/commands/commit.md`). A spec do Espectro precisa ser versionada e lida no GitHub |
| Usar o writer de Self-SDD | Controla versão e ativação por hash, não conteúdo nem navegação. Segue congelado pela D5; esta proposta não toca nele |
| Escrever a spec do sistema inteiro de uma vez | Vira uma spec grande e defasada em que ninguém confia. O mapa nasce completo; a spec de cada capacidade nasce quando uma mudança a toca |
| Arquitetura Limpa em camadas, DDD tático | Já tentada (`scripts/src`, só `.gitkeep` desde 30/10). O estado é um JSON com CAS, não um modelo de objetos |
| Vault do Obsidian como fonte | O vault é lente gerada e descartável. A fonte é o repo |

## Capacidades iniciais (a confirmar na fatia C1)

Um módulo de código = uma capacidade = uma spec. Os nomes saem das famílias de arquivo que já existem.

| Tipo | Capacidade | O que faz |
| -- | -- | -- |
| Base | `estado` | `state.json` de cada Run: único escritor, versão, lease de nó |
| Base | `grafo` | Nós, ordem, arestas e limites de retry (F2.7) |
| Base | `config` | Variáveis de ambiente e registro de flags |
| Capacidade | `spec` | Gera, valida, versiona e invalida a spec de um ticket |
| Capacidade | `portoes` | Conferências entre nós: plano, build, churn, veredito de revisão |
| Capacidade | `autorizacao` | Aceites e autorização humana |
| Capacidade | `execucao` | Despacha o agente de cada nó e monta o contexto |
| Capacidade | `roteamento` | Modelo, esforço por fase e decomposição |
| Capacidade | `qa` | Recusa de QA: retry e diagnóstico |
| Capacidade | `medicao` | Custo, transcrições, comparação de runs |
| Capacidade | `integracoes` | Redmine, Bitbucket, notificações |
| Capacidade | `db-effect` | Efeito de migração de banco |
| Capacidade | `sdd-writer` | Writer de SDD por projeto (sem chamador, D5) |
| Fluxo | `ciclo-da-run` | O watcher: tick, descoberta, ordem dos portões, despacho |
| Fluxo | `dashboard` | Painel local: tarefas, custo, pedidos de decisão |

## Fatias

| ID | Entrega | Nível | Dias | Termina em |
| -- | -- | -- | -- | -- |
| C1 | Mapa: `README.md` com as 15 linhas, visão em dez linhas, fluxo da Run, glossário; um arquivo por capacidade só com cabeçalho; os dois primeiros testes | Leve | 2 | Richard abre uma página e responde "o que faz, o que está ligado, onde mora" |
| C2 | Três specs completas, das capacidades em obra: `spec` (PRI-395), `grafo` (F2.7), `estado`. Seção de delta no `templates/fatia-spec.md.template`. Aviso no `processo-check` | Leve | 3 | Um PR de teste que muda `spec` sem tocar a spec viva recebe o aviso |
| C3 | Arrumar a casa: `tasks/` de issue fechada vai para arquivo; `docs/prisma/` marcado como histórico; as cinco contradições corrigidas (fluxo de dev, verify → implement, visibilidade, versão do Node, `memory/decisions`) | Leve | 1 | `tasks/` só com o que está em curso; uma só descrição do fluxo de dev |
| C4 | Lente: exportador do Obsidian organizado por capacidade (nota-hub com spec, módulos, testes, decisões, issues) | Médio | 2 | Só depois de C1 e C2, e de o Richard abrir o vault atual uma vez |

A estrutura de código acompanha em trilha própria, sem data nesta proposta: monólito
modular por capacidade em `scripts/lib/<capacidade>/`, entrada só pelo `index.js`, regra no
dependency-cruiser, um módulo por PR. Módulo novo (`grafo` na F2.7, `config`) já nasce em
pasta. No `tasks/design-de-codigo`, muda o destino do `nucleo-watcher`: cada seção vai para
o módulo dono, não para `scripts/watcher/<seção>.js`.

## Decisões pedidas

| ID | Pergunta | Recomendação |
| -- | -- | -- |
| P1 | Aprovar C1 a C3 (Leve, cerca de 6 dias, fora das fases do roadmap)? | Sim. C1 começa agora; C2 e C3 em seguida |
| P2 | O que fazer com a D-SDD-01 (entrada e gates do SDD), aprovada em 16/11? | Manter só o `ac-heading-unico` (PRI-395, defeito reproduzido). Os outros quatro módulos de runtime não entram na Fase 2; voltam quando a capacidade `spec` ou `portoes` tiver spec viva. O `fluxo-dev-unico` é absorvido pela C3 |
| P3 | Aprovar a direção de arquitetura (monólito modular por capacidade) e o ajuste no `tasks/design-de-codigo`? | Sim para a direção. Nenhum movimento de arquivo agendado além do que a F2.7 e o `config-central` já criam |
| P4 | Lente de leitura: Obsidian gerado ou tela no dashboard? | Decidir depois da C1. O piso é o markdown no GitHub |

A fila "Com o Richard" já está acima do limite de três itens. Esta proposta entra como mais um.

## Não confirmado

- Quantos testes quebram `require` relativo ao mover arquivos para subpastas.
- Se o consumidor corporativo cita caminhos de `scripts/lib` fora deste repo (templates e comandos daqui citam 39).
- Os painéis `.base` e a abertura por URI do exportador nunca foram validados no app do Obsidian.
- A lista de 15 capacidades vem de classificação por nome de arquivo; a C1 confere arquivo a arquivo.

## Fontes

- Spec viva com delta: [OpenSpec, conceitos](https://github.com/Fission-AI/OpenSpec/blob/main/docs/concepts.md) e [projetos existentes](https://github.com/Fission-AI/OpenSpec/blob/main/docs/existing-projects.md).
- Limites do SDD: [Böckeler, Kiro, spec-kit e Tessl](https://martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html); [Thoughtworks Radar](https://www.thoughtworks.com/radar/techniques/spec-driven-development).
- Contexto gerado não ajuda o agente: [Evaluating AGENTS.md](https://arxiv.org/abs/2602.11988).
- Fronteira por módulo com dependency-cruiser: [lastminute.com](https://technology.lastminute.com/how-we-enforce-architecture-boundaries-at-scale-on-our-app/).
- Medidas de acoplamento deste repo: dependency-cruiser em modo leitura, 16/11 (227 módulos, 381 arestas, 77 violações).
