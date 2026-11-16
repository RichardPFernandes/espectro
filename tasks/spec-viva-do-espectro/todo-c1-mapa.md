# Tarefas C1 (PRI-396)

Plano: [`plan-c1-mapa.md`](plan-c1-mapa.md). Suíte: `npm test` (Node 24). Focado:
`node --test scripts/capability-map.test.js`. Estática: `npm run check`. Toda tarefa de código
começa pelo teste que falha.

## Fase 1 — Script e regras

- [x] **T1: ler cabeçalho e achar o dono de um arquivo (AC-02, AC-06)** · S
  - Aceite: o script lê o cabeçalho de `docs/capacidades/*.md` (escalar, lista em linha, lista em bloco) e recusa campo ausente, valor fora do enum ou forma não suportada; `--of <caminho>` imprime o id e sai 0, ou sai 1 sem dono; `estado.md` existe como primeira capacidade real.
  - Verificar: teste focado verde; `node scripts/capability-map.js --of scripts/cas.js` → `estado`.
  - Arquivos: `scripts/capability-map.js`, `scripts/capability-map.test.js`, `docs/capacidades/estado.md`
  - Depende de: nada

- [ ] **T2: regras de cobertura e de flag, em casos sintéticos (AC-02, AC-03)** · S
  - Aceite: em diretório temporário, o teste mostra falha com mensagem para arquivo sem dono, arquivo com dois donos, padrão que não casa com nada e flag que não aparece no código da capacidade; `--check` no repo lista quantos arquivos faltam e sai 1.
  - Verificar: teste focado verde; `--check` imprime a contagem.
  - Arquivos: `scripts/capability-map.js`, `scripts/capability-map.test.js`
  - Depende de: T1

### Conferência A

- [ ] As quatro falhas sintéticas aparecem com arquivo e comando de correção; `npm test` verde.

## Fase 2 — Classificação

Em cada capacidade: cabeçalho completo, duas a quatro frases, até cinco arquivos por onde
começar, até 40 linhas. Situação e flags conferidas no código; guardar caminho e linha para a
Evidência do PR.

- [ ] **T3: base e ciclo — `estado`, `grafo`, `config`, `ciclo-da-run`, `execucao`** · M
  - Aceite: os cinco arquivos existem; `.claude/commands/` e `.graph/` têm dono; nenhum arquivo dessas capacidades casa com dois padrões.
  - Verificar: `--check` mostra a contagem de faltantes caindo e nenhum conflito.
  - Arquivos: `docs/capacidades/{estado,grafo,config,ciclo-da-run,execucao}.md`
  - Depende de: T2

- [ ] **T4: produto — `spec`, `portoes`, `autorizacao`, `roteamento`, `qa`, `db-effect`, `sdd-writer`** · M
  - Aceite: os sete arquivos existem; `sdd-writer` com `situacao: sem-chamador`; nenhum conflito.
  - Verificar: `--check` sem conflito; contagem de faltantes cai.
  - Arquivos: `docs/capacidades/{spec,portoes,autorizacao,roteamento,qa,db-effect,sdd-writer}.md`
  - Depende de: T2. Pode rodar em paralelo com a T3.

- [ ] **T5: bordas e cobertura ligada — `medicao`, `integracoes`, `dashboard`, `ferramentas` (AC-03)** · M
  - Aceite: os quatro arquivos existem; `--check` sai 0 no repo; o teste de cobertura contra o repo real está ligado; a lista do que mudou de capacidade em relação à `PROPOSTA.md` está escrita para o PR.
  - Verificar: teste focado verde; `npm test` verde.
  - Arquivos: `docs/capacidades/{medicao,integracoes,dashboard,ferramentas}.md`, `scripts/capability-map.test.js`
  - Depende de: T3, T4

### Conferência B

- [ ] `--check` sai 0; as 16 capacidades fecham. Se for preciso criar, fundir ou cortar capacidade, parar e perguntar ao Richard.

## Fase 3 — Página de entrada

- [ ] **T6: `README.md` do mapa — visão, ciclo da Run e glossário (AC-01, AC-07)** · S
  - Aceite: as quatro seções na ordem da SPEC; diagrama Mermaid com nós, portões e pontos de decisão humana; os 18 termos do glossário presentes; até 150 linhas; "gate" só como nível de revisão. O teste confere seções, termos e teto de linhas, do README e de cada capacidade.
  - Verificar: teste focado verde; ver o diagrama renderizado no GitHub depois do push.
  - Arquivos: `docs/capacidades/README.md`, `scripts/capability-map.test.js`
  - Depende de: T5

- [ ] **T7: tabela gerada (AC-04)** · S
  - Aceite: `--write` reescreve só o trecho entre os marcadores; rodar duas vezes não muda nada; tabela defasada faz o teste falhar com a instrução de rodar `--write`.
  - Verificar: teste focado verde, com caso sintético de tabela defasada.
  - Arquivos: `scripts/capability-map.js`, `scripts/capability-map.test.js`, `docs/capacidades/README.md`
  - Depende de: T6

- [ ] **T8: links relativos (AC-05)** · S
  - Aceite: link relativo para arquivo que não existe, em qualquer arquivo de `docs/capacidades/`, faz o teste falhar citando arquivo e link; links externos e âncoras não são conferidos.
  - Verificar: teste focado verde, com caso sintético de link quebrado.
  - Arquivos: `scripts/capability-map.js`, `scripts/capability-map.test.js`
  - Depende de: T1. Fica aqui porque só tem o que conferir depois da T6.

- [ ] **T9: ponteiros de entrada (AC-08)** · XS
  - Aceite: o `README.md` da raiz, antes do sumário, e o passo 1 do `AGENTS.md` apontam para `docs/capacidades/README.md`; nenhuma outra linha desses arquivos muda.
  - Verificar: `git diff --stat` mostra só as linhas dos ponteiros.
  - Arquivos: `README.md`, `AGENTS.md`
  - Depende de: T6

### Conferência C

- [ ] `npm test` e `npm run check` verdes.
- [ ] Revisão G3 por outro agente Claude em contexto limpo; achados tratados.
- [ ] PR em draft, `Refs PRI-396`, rótulo `processo:medio`, Evidência por AC, com as três perguntas do AC-09 para o Richard.
- [ ] Bloco de Estado da PRI-396 atualizado.
