# Documentação do Espectro

## O que há aqui

- [`capacidades/README.md`](capacidades/README.md): o mapa do que o Espectro faz. Comece por ele.
- [`adr/`](adr/README.md): decisões de arquitetura já tomadas.
- [`historico/`](historico/): SPECs de fatias já fechadas.
- Os demais arquivos são guias e runbooks soltos, como [`fluxo-dev.md`](fluxo-dev.md) e [`runbook.md`](runbook.md).

## Abrir no Obsidian

1. No Obsidian, use **Abrir pasta como cofre** e escolha a pasta `docs/` deste repositório.
2. Abra o grafo (Graph view). Cada capacidade aparece ligada aos ADRs que a citam, depois que os ADRs
   ganharem cabeçalho e a seção "Ligações" for gerada (PRI-413, PR #239). Antes disso o grafo só mostra
   os links escritos no texto.
3. Os campos do cabeçalho (front-matter) aparecem como propriedades da nota.

As ligações vêm da seção "Ligações" no fim de cada página de `capacidades/` e `adr/`. Ela é gerada a partir do cabeçalho. Não edite à mão: rode `node scripts/knowledge-links.js --write` na raiz do repositório.

## Limites

- Links que apontam para fora de `docs/` (como `../../scripts/...`) não abrem dentro do vault.
- As SPECs de `tasks/` ficam fora de `docs/`. Só entram no vault depois de ir para `historico/`.
- O Obsidian cria a pasta `.obsidian/` dentro de `docs/`. O git a ignora; ela não entra no repositório.
- Editar no vault é editar o repositório: são os mesmos arquivos, e a mudança segue o fluxo normal de PR.

Não confunda com [`obsidian.md`](obsidian.md): lá, um exportador gera um vault separado e somente leitura do repositório inteiro. Aqui, o vault é a própria pasta `docs/`.
