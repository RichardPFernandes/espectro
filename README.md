<div align="center">

<picture>
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/espectro-mark-light.svg">
  <img src="docs/assets/espectro-mark.svg" width="88" height="88" alt="Lente do Espectro: círculo em três faixas horizontais, azul, verde e âmbar">
</picture>

# espectro

**Um pedido entra, se decompõe em estados verificáveis.**

Plataforma de engenharia de software com agentes: transforma um ticket em um
grafo de nós auditáveis, com gates humanos, custo visível e estado autoritativo
que nunca sai do projeto consumidor.

[![Tests](https://github.com/RichardPFernandes/prisma/actions/workflows/tests.yml/badge.svg)](https://github.com/RichardPFernandes/prisma/actions/workflows/tests.yml)
![Node](https://img.shields.io/badge/node-22%20%7C%2024-3DD68C)
![Status](https://img.shields.io/badge/status-dogfood%20(app--back)-F2A93B)
![Repo](https://img.shields.io/badge/repo-privado-6E9BFF)

</div>

> **Nome.** Espectro é o nome do produto (antes chamado Prisma). O repositório,
> as variáveis (`PRISMA_ROOT`), as issues (`PRI-*`) e os documentos históricos
> mantêm o nome `prisma`.

## Sumário

- [O que é](#o-que-é)
- [Como funciona](#como-funciona)
- [Identidade](#identidade)
- [Estrutura do repositório](#estrutura-do-repositório)
- [Primeiros passos](#primeiros-passos)
- [Consumo pelo app-back](#consumo-pelo-app-back)
- [Documentação](#documentação)
- [Governança e contribuição](#governança-e-contribuição)
- [Licença](#licença)

## O que é

O Espectro automatiza o ciclo de desenvolvimento de um ticket com agentes, sem
deixar que a automação se passe por autoridade sobre o domínio. Ele entrega:

- **Watcher** que busca tickets elegíveis e despacha, a cada tick, o próximo nó
  do grafo para um agente.
- **Dashboard** local (Express, `127.0.0.1:3333`) para acompanhar runs, decidir
  gates, autorizar ações privilegiadas e ver custo por run, nó e tentativa.
- **Estado verificável**: cada task tem um `state.json` validado por schema,
  snapshots e Context Records imutáveis, e histórico que não é reinterpretado
  por configuração nova.

O **app-back** é o primeiro consumidor (dogfood). Configuração, credenciais,
dados, worktrees e estado autoritativo ficam no consumidor; este repositório
contém só o código da plataforma e seus assets versionados.

## Como funciona

```text
fetch_ticket → plan → implement → review → test → verify → commit
                          ▲           │       │       │
                          └───────────┴───────┴───────┘  reprovado: volta (máx. 3; verify máx. 2)
                                                          estourou: escalated → humano
```

| Peça | Papel | Onde |
| --- | --- | --- |
| Dashboard | Controla o watcher e mostra runs, gates e custo | [`dashboard/server.js`](dashboard/server.js) |
| Laço do watcher | Dispara um tick a cada `WATCHER_TICK_INTERVAL_MS` (padrão 60 s) | [`scripts/watcher-manager.js`](scripts/watcher-manager.js) |
| Tick | Processo que roda uma vez e sai; despacha o próximo nó | [`scripts/readmine-watcher.js`](scripts/readmine-watcher.js) |
| Grafo | Nós, transições e limites de retry | [`.graph/graph.yaml`](.graph/graph.yaml) |
| Estado | Fonte única de verdade de cada task | `memory/runs/<task-id>/state.json` no consumidor |

Três regras atravessam tudo:

- **A tela pede, o domínio decide.** Um botão de decisão envia um pedido e mostra
  "enviado", nunca "aprovado", até o registro humano existir.
- **Todo número diz de onde vem.** Telemetria aparece como sinal, não como fato.
- **Efeito externo incerto não se repete.** Em 401/403, drift ou resultado
  ilegível, a operação dependente para e vai para decisão humana.

Detalhes, status do `state.json` e cenários de falha: [runbook](docs/runbook.md).

## Identidade

O design system completo (tokens, temas, tipografia e regras de marca) está no
artifact **[Espectro — design system](https://claude.ai/artifact/Cd1FBi9w4zrRr9gzWm9Hn7)**.
O resumo:

**A Lente.** O símbolo é um círculo visto através do espectro, já separado em
três faixas horizontais. As faixas são as próprias cores de estado: a marca é o
sistema em miniatura.

| Faixa | Token | Escuro | Claro | Estado |
| --- | --- | --- | --- | --- |
| Superior | `accent` | `#6E9BFF` | `#2F5FD0` | ◐ Em execução |
| Central | `state-done` | `#3DD68C` | `#157A4C` | ✓ Concluído |
| Inferior | `state-waiting` | `#F2A93B` | `#E3920F` | ‖ Aguardando você |

- A ordem das faixas é fixa e a lente não gira. Falhou (vermelho) nunca entra
  na marca. Nunca degradê, sombra ou contorno.
- Lockup: símbolo + "espectro" em Inter 600, tracking −3%, sempre em minúsculas.
  No texto corrido, Espectro com inicial maiúscula.
- Arquivos: [`docs/assets/espectro-mark.svg`](docs/assets/espectro-mark.svg)
  (fundo escuro) e [`docs/assets/espectro-mark-light.svg`](docs/assets/espectro-mark-light.svg)
  (fundo claro).

**Interface.** Tema escuro por padrão e claro equivalente, grade de 8 px, Inter
para leitura e JetBrains Mono para tudo que é de máquina (`APP-218 · implement ·
3/7 · US$ 0,86`). Neutros fazem quase todo o trabalho; a cor aparece só na ação
primária e nos cinco estados (✓ ◐ ‖ ✕ ○), que sempre têm glifo além da cor.
Âmbar é reservado para o que espera uma pessoa.

**Voz.** Português do Brasil, frases com inicial maiúscula, direto. Dado que não
existe vira placeholder explícito, nunca número plausível.

## Estrutura do repositório

```text
.
├── scripts/      watcher, libs de estado, gates e integrações (pacote graph-scripts)
├── dashboard/    servidor e UI local (pacote graph-dashboard)
├── harness/      receita oficial de testes, isolada e loopback-only
├── .graph/       grafo de nós e schemas do state.json
├── templates/    spec, handoff e checklists
├── provenance/   manifesto e proveniência da extração
└── docs/         baseline, runbooks, contratos e histórico
```

São dois pacotes Node independentes, cada um com manifest e lock próprios. Não
há runner na raiz.

## Primeiros passos

**Requisitos:** Node 22 ou 24 (matriz da CI; a extração original foi verificada
com Node 20.20.2/npm 10.8.2), npm e Git.

1. Instale as dependências travadas em cada pacote:

   ```bash
   npm ci --ignore-scripts --no-audit --no-fund --prefix scripts
   ```

   ```bash
   npm ci --ignore-scripts --no-audit --no-fund --prefix dashboard
   ```

2. Rode a receita oficial de testes. O harness exige roots absolutos, não herda o
   seu ambiente e bloqueia rede fora de loopback (mesma receita da
   [CI](.github/workflows/tests.yml)):

   ```bash
   CK="$PWD"; EV="$(mktemp -d)"; mkdir -p "$EV/home" "$EV/tmp"
   for pkg in scripts dashboard; do
     env -i PATH="$(dirname "$(command -v node)"):/usr/bin:/bin" \
       HOME="$EV/home" TMPDIR="$EV/tmp" \
       NODE_OPTIONS="--require=$CK/harness/loopback-only.cjs" \
       PRISMA_ROOT="$CK" REPO_PATH="$CK" \
       npm --prefix "$CK/$pkg" test
   done
   ```

3. Checagens estáticas, quando tocar no código:

   ```bash
   npm --prefix scripts run check:js && npm --prefix scripts run arch:check
   ```

Este README não inicia watcher, agente ou preview. Iniciar a plataforma contra um
consumidor real segue o [runbook de consumo](docs/consumer-operations.md).

## Consumo pelo app-back

O consumidor entregue na PRI-63 está fixado em `a50ff9f`; a `main` posterior
contém mudanças ainda não admitidas nele.

- Não use latest para reatar uma Run nem atualize o pin por publicação de
  documentação.
- No app-back, `npm start` do dashboard chama o launcher dele, que fixa roots,
  revisão e hashes da configuração. `npm run start:source` é o retorno explícito,
  após parada, conferência de writers e saneamento do ambiente.
- Código e assets pertencem a `PRISMA_ROOT`; `REPO_PATH`, `.env`, memory,
  worktrees e histórico pertencem ao consumidor. Segredos nunca entram aqui.

Preparação, diagnóstico, cutover e retorno: [docs/consumer-operations.md](docs/consumer-operations.md).

## Documentação

| Para | Leia |
| --- | --- |
| Entender a arquitetura e os contratos | [Baseline e contratos](docs/prisma/README.md) |
| Operar e diagnosticar | [Runbook](docs/runbook.md) · [Consumo e cutover](docs/consumer-operations.md) |
| Escrever specs | [Guia de specs](docs/spec-guide.md) · [Versionamento](docs/spec-versioning.md) |
| Entregar ou interromper uma tarefa | [Contrato de handoff](docs/handoff-contract.md) · [template](templates/handoff.yaml.template) |
| Saber o que foi extraído e por quê | [Handoff da extração](docs/extraction-handoff.md) · [paths](docs/extraction-paths.md) · [manifesto](provenance/extraction-manifest.json) |
| Instruções para agentes neste repo | [AGENTS.md](AGENTS.md) |

## Governança e contribuição

Toda mudança segue **Plan → Implement → Review independente → Test → Verify →
Commit**, com evidência atribuível à versão. Leia o [AGENTS.md](AGENTS.md) antes
de alterar qualquer coisa.

- **Onde cada coisa vive.** Roadmap/Freeze governam a arquitetura, o Linear
  conserva planejamento e decisões, o Git conserva implementação e documentação,
  e runtime/CI comprovam o que foi executado.
- **Limites vigentes.** A extração local não certifica MP-00, SDD READY, produção
  TMS ou DOM06 na revisão consumida. RRC-F31-001/002 continuam NOT APPLIED.
  Nenhum dado ou estado do app-back acompanha este repositório.
- **UNKNOWN não vira aprovação.** Ausência de prova não conta como zero.

Proveniência desta documentação: [pri-64-documentation.json](provenance/pri-64-documentation.json).

### Histórico atribuído

[Bootstrap PRI-59](docs/bootstrap.md), [entrada PRI-60](docs/extraction-entry.md),
[candidata PRI-60](docs/pri-60-candidate.md), [consumo original](docs/consumption.md)
e [retorno PRI-62](docs/rollback.md) conservam capturas das respectivas revisões.
São registro histórico, não instrução atual; o estado vigente está no handoff e
no runbook de consumo.

## Licença

Repositório privado de [RichardPFernandes](https://github.com/RichardPFernandes).
Não há licença pública; uso e distribuição dependem de autorização do titular.
