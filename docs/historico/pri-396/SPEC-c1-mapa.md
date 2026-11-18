# SPEC C1: mapa de capacidades do Espectro

> **Fatia:** C1 de [`PROPOSTA.md`](../../../tasks/spec-viva-do-espectro/PROPOSTA.md), fora das fases do roadmap (pedido do Richard em 16/11) · **Issue:** [PRI-396](https://linear.app/prisma-app/issue/PRI-396) · **Nível:** Médio (cria um teste que reprova todo PR com arquivo de código sem capacidade; reclassificado pelo Richard em 16/11)
> **AUTORIZO:** não precisa · **Flag:** nenhuma (não muda código executado numa Run)
> **Decisões citadas:** D5, D-SDD-02 (Mesa de Decisões) · **Código lido em:** `main` `73a5dba` mais os commits da PRI-393 (`e83144c`)

## Contexto (AS-IS)

- Não existe `docs/capacidades/` nem outro mapa por capacidade. O `README.md` da raiz (273 linhas) é a melhor visão geral, e o `AGENTS.md` manda começar por ele (`AGENTS.md:3`).
- `scripts/lib` tem 114 arquivos de código sem subpasta; a raiz de `scripts/` tem 39 e `dashboard/` tem 49. São 215 arquivos de código (`.js`, `.mjs`, `.cjs`, `.sh`, sem testes) nos dois pacotes.
- O comportamento real dos nós está em 11 arquivos de `.claude/commands/`; o grafo e os schemas, em 7 arquivos de `.graph/`.
- O `ownership.yaml` liga 41 arquivos a 38 capacidades, quase uma por arquivo, todas com `owner: UNKNOWN` (`ownership.yaml:10-14`). Só o exportador do Obsidian o lê (`scripts/obsidian-export.js:172-173`).
- A receita roda todo `*.test.js` do checkout, por nome (`harness/run-tests.js:59-89`). Não há biblioteca de YAML nas dependências (`scripts/package.json:17-32`).
- "Gate" nomeia a conferência do watcher entre nós e também os níveis G0–G3 de revisão. "Spec" nomeia a spec de um ticket, a SPEC de uma fatia e a spec viva.

## Objetivo

Quem abre o repo passa a ter uma página que responde "o que o Espectro faz, o que está ligado e onde mora cada coisa". Cada arquivo de código tem uma capacidade dona, e a suíte de testes reprova quando esse mapa deixa de ser verdade. Usuários: o Richard, lendo no GitHub, e os agentes, que passam a carregar uma capacidade em vez do repo inteiro.

## Não inclui

- Spec completa de qualquer capacidade, seção de delta no template e aviso no `processo-check` (fica para C2).
- Arquivar `tasks/`, marcar `docs/prisma/` como histórico, corrigir contradições entre documentos (fica para C3).
- Exportador do Obsidian por capacidade (fica para C4).
- Mover ou renomear arquivo de código; mudar regra do dependency-cruiser (trilha de módulos, sem data).
- Conferir se cada flag está ligada no consumidor: o mapa cita o padrão lido no código; o registro de flags é a F1.1.
- Editar ou substituir o `ownership.yaml` (PRI-104): ele trata de owner lógico, não de navegação.

## Critérios de aceite

- AC-01: `docs/capacidades/README.md` tem até 150 linhas e traz, nesta ordem: o que o Espectro faz em até dez linhas; o ciclo de uma Run do ticket ao PR (lista numerada e um diagrama Mermaid com nós, portões e pontos de decisão humana); o glossário; a tabela de capacidades.
- AC-02: há um `docs/capacidades/<id>.md` por capacidade, com até 40 linhas, o cabeçalho completo e, no corpo, o que a capacidade faz em duas a quatro frases e até cinco arquivos por onde começar a ler. Toda flag listada no cabeçalho aparece, por nome, em algum arquivo da própria capacidade; senão o `npm test` falha.
- AC-03: todo arquivo de código de `scripts/` e `dashboard/` e todo arquivo de `.claude/commands/` e `.graph/` pertence a exatamente uma capacidade. Arquivo sem dono, com dois donos, ou padrão que não casa com nenhum arquivo faz o `npm test` falhar, citando o arquivo e o comando que corrige.
- AC-04: a tabela de capacidades do `README.md` é gerada dos cabeçalhos por `--write`. Tabela defasada faz o `npm test` falhar.
- AC-05: link relativo que não aponta para arquivo existente, em qualquer arquivo de `docs/capacidades/`, faz o `npm test` falhar.
- AC-06: `node scripts/capability-map.js --of <caminho>` imprime o id da capacidade dona e sai 0; para caminho sem dono, sai 1.
- AC-07: o glossário dá um só sentido a cada termo: Espectro e Prisma, consumidor, Run, watcher, tick, nó, portão, gate (G0–G3), spec de ticket, spec viva, SPEC de fatia, SDD, writer de SDD, flag, fatia, AUTORIZO, lease, Attempt. Em `docs/capacidades/`, "gate" só nomeia nível de revisão; a conferência do produto é "portão".
- AC-08: o `README.md` da raiz, antes do sumário, e o passo 1 do `AGENTS.md` apontam para `docs/capacidades/README.md` como ponto de partida.
- AC-09: lendo só o mapa, o Richard responde três perguntas escolhidas por ele na revisão do PR, uma de cada tipo: "o que faz X", "X está ligado?", "onde mora X".

## Como é construído

**Comandos.**

```bash
npm test                                         # receita oficial; inclui o teste do mapa
node --test scripts/capability-map.test.js       # foco, durante o trabalho
node scripts/capability-map.js --check           # mesmo que o teste, com mensagem para gente
node scripts/capability-map.js --write           # regenera a tabela do README
node scripts/capability-map.js --of scripts/cas.js
npm run check                                    # check:js e arch:check
```

**Estrutura.**

```text
docs/capacidades/README.md        página de entrada; tabela entre marcadores, gerada
docs/capacidades/<id>.md          uma por capacidade (16 de início)
scripts/capability-map.js         leitura dos cabeçalhos, cobertura, links, tabela; CLI
scripts/capability-map.test.js    um teste por AC verificável (AC-01 a AC-06)
```

**Estilo.** Cabeçalho num subconjunto de YAML: escalar, lista em linha ou lista em bloco de strings. Qualquer outra forma é erro do teste. Um padrão em `modulos` é um caminho exato ou um prefixo terminado em `*`.

```markdown
---
id: spec
tipo: capacidade            # base | capacidade | fluxo
resumo: Gera, valida, versiona e invalida a spec de um ticket.
situacao: ligada            # ligada | parcial | desligada | sem-chamador
spec: sem-spec              # sem-spec | rascunho | viva
flags: [SPEC_DRAFT_AUTOGEN, SPEC_AUTO_REPAIR]
modulos:
  - scripts/lib/spec-*
  - scripts/lib/ac-*
  - scripts/invalidate.js
---
```

Texto em português, frases curtas, um termo por conceito (glossário). Os documentos citam caminho, nunca linha: linha envelhece. O script segue o padrão dos CLIs da raiz de `scripts/`: CommonJS, `"use strict"`, `node:test` e `node:assert/strict`, sem dependência nova, funções puras exportadas e `main` só com I/O.

**Testes.** Cada regra (AC-03, AC-04, AC-05) tem um teste contra o repo real e um teste sintético que injeta o defeito num diretório temporário e espera a falha, como em `scripts/architecture-boundaries.test.js`. A listagem de arquivos usa `git ls-files` com os novos não ignorados, igual à receita. Arquivo `*.test.js` não entra na cobertura: segue o vizinho.

**Limites.**

- **Sempre:** PR em draft com "Refs PRI-396", rótulo `processo:medio` e evidência por AC; uma revisão G3 por outro agente Claude em contexto limpo; situação e flags de cada capacidade conferidas no código, com caminho e linha na Evidência do PR; `npm test` verde antes do PR.
- **Perguntar antes:** criar, fundir ou cortar capacidade além das 16 iniciais; tocar o `ownership.yaml`; mudar qualquer outro documento existente além dos dois ponteiros do AC-08.
- **Nunca:** mover, renomear ou editar arquivo de código existente; criar capacidade "outros" ou "misc"; copiar dado do consumidor; tocar o writer de SDD; descrever no mapa o que o código não mostra.

## Como se demonstra

- AC-01, AC-02: `node --test scripts/capability-map.test.js` → limites de linhas e seções obrigatórias passam; link do `README.md` renderizado no GitHub vai na Evidência.
- AC-03 a AC-05: mesmo teste → verde no repo; os três testes sintéticos mostram a falha com a mensagem.
- AC-06: `node scripts/capability-map.js --of scripts/cas.js` → `estado`, exit 0; `--of nao/existe.js` → exit 1.
- AC-07, AC-08: leitura na revisão; os termos do glossário são conferidos pelo teste do AC-01.
- AC-09: as três perguntas e as respostas do Richard, transcritas na Evidência do PR.

## Fica ligado?

- Sim: ligado ao fim da fatia. O teste do mapa roda no `npm test` e na CI, e o `README.md` da raiz aponta para o mapa. Sem flag: não há código de Run.

## Riscos e perguntas abertas

- **Decidido em 16/11 pelo Richard:** SPEC aprovada; nível Médio, com esta SPEC no PR e uma revisão G3; a 16ª capacidade, `ferramentas`, é criada para os scripts offline (demo, sondas, limpeza, exportadores, o próprio mapa).
- **Risco: PRs em voo.** PRI-393, PRI-395 e F2.7 criam arquivos. Depois do merge da C1, o PR que trouxer arquivo sem dono reprova. Mitigação: prefixos com `*` cobrem as famílias de nome, e a mensagem de falha traz o comando.
- **Risco: mapa errado por nome.** A lista de capacidades veio de classificação por nome de arquivo. Mitigação: a fatia confere arquivo a arquivo, e o PR lista os que mudaram de capacidade em relação à proposta.
- **Risco: virar mais um documento.** Mitigação: tetos de 150 e 40 linhas no teste, tabela gerada e AC-09.
