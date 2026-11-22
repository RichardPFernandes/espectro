---
id: ferramentas
tipo: capacidade
resumo: Scripts offline fora do caminho da Run, como demo, sondas, limpeza, exportadores, validadores de processo e o próprio mapa.
situacao: ligada
spec: viva
flags: []
adrs: [ADR-0001, ADR-0002, ADR-0007, ADR-0008]
modulos:
  - scripts/capability-map.js
  - scripts/lib/front-matter.js
  - scripts/knowledge-links.js
  - scripts/lib/knowledge-links.js
  - scripts/demo.js
  - scripts/probes/*
  - scripts/harness/*
  - scripts/cli-proof-inventory.js
  - scripts/lib/cli-proof-inventory.js
  - scripts/run-*
  - scripts/lib/lint-baseline.js
  - scripts/lib/roadmap-*
  - scripts/cleanup-*
  - scripts/obsidian-export.js
  - scripts/export-runs.js
  - scripts/lib/runs-exporter.js
  - scripts/validate-handoff.js
  - scripts/return-point.js
  - scripts/lib/maestro-guard-pre-done.js
  - scripts/src/platform/marker.js
---

# Ferramentas

Scripts que o dev ou o CI chamam à mão e que nenhum nó da Run precisa para andar: o `demo.js` (ciclo simulado, sem credencial nem rede), as sondas e o harness, os exportadores, os validadores (`validate-handoff.js`, `roadmap-lint.js`), o gerador da página do roadmap (`roadmap-site.js`) e este mapa.
A exceção é a limpeza de Runs: o watcher chama `cleanup-runs.js` ao subir, e `DISABLE_AUTO_CLEANUP=true` desliga isso. Se um script daqui passar a ser chamado por um nó, ele muda de capacidade.

## Propósito

O dev e a CI precisam saber, sem ler o repo inteiro, quem é dono de cada arquivo de código e o que cada página de
capacidade promete. As ferramentas deste mapa existem para que essa resposta seja conferida por script, não por memória.

## Requisitos

| ID | Comportamento | Porquê |
| -- | -- | -- |
| FERRAMENTAS-R01 | Quando `--check` roda, cada arquivo `.js`, `.mjs`, `.cjs` ou `.sh` de `scripts/` e `dashboard/`, e todo arquivo de `.claude/commands/` e `.graph/`, tem exatamente uma capacidade dona (teste, fixture e `.gitkeep` ficam fora); sem dona ou com duas, o comando lista o arquivo e sai 1. | Arquivo sem dona escapa da spec viva. |
| FERRAMENTAS-R02 | Se `--of <caminho>` não acha uma só dona, imprime o motivo e sai 1; com uma dona, imprime o `id` e sai 0. | O `/pri-start` e o `/pri-check` leem a dona por esse código de saída. |
| FERRAMENTAS-R03 | O cabeçalho de cada página tem `id`, `tipo`, `resumo`, `situacao`, `spec`, `flags` e `modulos`; `depende_de` e `adrs` são opcionais, listas, e valem `[]` quando faltam. Campo ausente, vazio ou fora desses nove, valor de `tipo`, `situacao` ou `spec` fora da lista, `id` diferente do nome do arquivo ou item fora do formato (`ADR-NNNN` em `adrs`, `id` de capacidade em `depende_de`) é erro de cabeçalho (exit 2). | Cabeçalho torto não pode virar mapa errado em silêncio. |
| FERRAMENTAS-R04 | Quando `--check` roda, o padrão de `modulos` sem arquivo, a flag do cabeçalho que não aparece no código da capacidade e a tabela do README defasada contam como problema. | Mapa que aponta para nada mente. |
| FERRAMENTAS-R05 | Enquanto o README tem os marcadores da tabela, `--write` reescreve só o que está entre eles; sem mudança, não grava. | A tabela é derivada; o resto do README é de quem escreve. |
| FERRAMENTAS-R06 | Quando `--check` roda, o link relativo inline das páginas de `docs/capacidades/` que aponta para arquivo inexistente ou para fora do repo é problema. | Página navegável é parte do contrato. |
| FERRAMENTAS-R07 | Quando `knowledge-links --check` roda, é problema (exit 1): ID de capacidade ou de ADR que não existe, em qualquer campo; lados que divergem (`adrs` da capacidade e `capacidades` do ADR; `substitui` e `substituida_por`); ADR sem `NNNN-` no nome, sem front-matter, sem `id` igual ao nome, `capacidades` ou `status`, com `status` fora do MADR ou `substituída` sem `substituida_por`. Em todo PR, o `processo-check` roda o `--check` com o script da base sobre as páginas do PR. | Ligação só vale se os dois lados concordam, e um PR não afrouxa a própria conferência. |
| FERRAMENTAS-R08 | A seção "Ligações" fica no fim da página, entre dois comentários HTML que ocupam uma linha cada, com links relativos e o título do ADR. Capacidade e ADR ligam nos dois sentidos; a SPEC de fatia com front-matter (`tasks/` e `docs/historico/`) só liga para a capacidade e o ADR que cita. Seção ausente, defasada (inclusive por título de ADR mudado) ou com marcador incompleto é problema; `--write` a regenera sem tocar no resto, sem mudança não grava, e com ID ou lado errado sai 1 sem escrever. Cabeçalho ilegível sai 2. | O link funciona no GitHub e no Obsidian, e o grafo mostra o que o front-matter diz. |

## Invariantes

- FERRAMENTAS-I01: nenhum nó da Run chama estes scripts, exceto `cleanup-runs.js`, que o watcher chama ao subir; quem passar a ser chamado por um nó muda de capacidade.
- FERRAMENTAS-I02: `--check` e `--of` só leem; `capability-map --write` só toca na tabela do README e `knowledge-links --write` só na seção `## Ligações`.

## Flags

Nenhuma flag liga ou desliga esta capacidade. `DISABLE_AUTO_CLEANUP`, que desliga a limpeza automática de Runs,
está no registro em [`docs/flags.md`](../flags.md).

## Por onde começar

1. [`scripts/demo.js`](../../scripts/demo.js): o ciclo simulado de `npm run demo`.
2. [`scripts/capability-map.js`](../../scripts/capability-map.js): este mapa, com `--check` e `--of`.
3. [`scripts/cleanup-runs.js`](../../scripts/cleanup-runs.js): rotação de Runs antigas, que só move.

<!-- ligacoes:inicio -->
## Ligações

- ADRs: [ADR-0001](../adr/0001-checkout-com-ponto-de-retorno.md) — O consumidor roda de checkout, com ponto de retorno; não volta ao pin
- ADRs: [ADR-0002](../adr/0002-monolito-modular-por-capacidade.md) — Monólito modular por capacidade, sem Arquitetura Limpa nem DDD tático
- ADRs: [ADR-0007](../adr/0007-spec-viva-por-capacidade.md) — Spec viva de uma página por capacidade, atualizada pelo delta no PR
- ADRs: [ADR-0008](../adr/0008-adrs-em-docs-adr-com-ligacoes.md) — Os ADRs moram em `docs/adr/`, ligados às capacidades por ID no front-matter
<!-- ligacoes:fim -->
