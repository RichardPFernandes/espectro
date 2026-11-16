# Espectro no Obsidian (somente leitura)

Gera um vault do Obsidian a partir deste repositório para ler specs e navegar pelas ligações. É uma **projeção**: a fonte de verdade é o Git, o estado operacional é o Linear. Nada volta do vault para a fonte (PRI-373, alternativa C da PRI-73).

## Uso

```
node scripts/obsidian-export.js --out ~/Vaults/espectro
```

Depois, no Obsidian: **Abrir pasta como cofre** e escolha a pasta. Rode de novo para atualizar. O comando só escreve em pasta vazia ou em vault que ele mesmo gerou (marcador `.espectro-vault.json`), e recusa `--out` dentro do repositório. Notas editadas no vault são apagadas na próxima exportação.

## Botão no dashboard

Com `PRISMA_OBSIDIAN=on` no ambiente do dashboard (padrão: desligado, e valor fora de `on`/`off` conta como desligado), o pé do menu lateral ganha **Abrir no Obsidian**. Sem flag, nenhuma rota é montada e nada aparece.

- **Sem vault ainda:** o botão vira **Criar vault e abrir no Obsidian**; o caminho que ele vai criar aparece ao passar o mouse (padrão `~/Vaults/espectro`). O clique roda o exportador e guarda a pasta em `dashboard/dashboard-prefs.json` (`obsidian_vault`, ignorado pelo git).
- **Com vault:** abre `obsidian://open?path=<pasta>` no Obsidian. Só abre; não regera.
- O dashboard não grava no vault: quem grava é o exportador, com as mesmas recusas de sempre (pasta alheia, dentro do repositório). O modo `PRISMA_DASHBOARD_READONLY=1` bloqueia a criação.
- Só funciona na máquina onde o dashboard roda (`obsidian://` abre o app local).
- Não verificado no app: se o Obsidian abre uma pasta que ainda não é um vault registrado, ou se pede para você escolher. Se pedir, use uma vez "Abrir pasta como cofre".

## Arquitetura das notas

| Camada | Pasta / nota | Papel |
| -- | -- | -- |
| Entrada | `00 Início` | Ponto de partida e dicas de navegação |
| Índices (MOC) | `01 Specs` a `07 Módulos` | Um por tipo; listas de links, que alimentam o grafo |
| Conteúdo | `Specs/`, `Docs/`, `Skills/`, `Comandos/`, `Tarefas/` | Uma nota por arquivo `.md` rastreado |
| Ligação | `Issues/PRI-n` | Uma nota por issue citada: link do Linear, quem a cita e issues relacionadas |
| Painéis | `Painéis/*.base` | Tabelas (core plugin Bases) de specs e issues |

- **Nomes:** `Tipo · caminho` (ex.: `Spec · pri-341`), únicos no vault.
- **Propriedades:** `tipo`, `titulo`, `origem`, `commit`, `atualizado`, `issues` (wikilinks) e `tags` (`espectro/<tipo>`). Toda issue citada no texto entra em `issues`, então o grafo liga a nota mesmo quando a citação está num bloco de código.
- **Links:** `PRI-n` e caminhos de notas conhecidas viram `[[wikilinks]]` fora de blocos de código e de títulos. Links Markdown relativos entre notas também são convertidos.
- **Fica de fora:** arquivos não rastreados (`.env`), mais de 300 KB e texto com cara de segredo (listados como `ignorado:` na saída).

## Navegar

Comece em uma spec e siga as issues; no painel de backlinks de uma issue aparece tudo que a cita. No Graph view, filtre por `tag:#espectro/spec` (ou `doc`, `issue`, `skill`) e crie grupos por tag para colorir.

## Limites

- O exportador é offline: título e estado das issues não vêm do Linear.
- Não testado no app: os `.base` passaram no validador local, mas nunca foram abertos no Obsidian. Se um painel falhar, os índices continuam funcionando.
