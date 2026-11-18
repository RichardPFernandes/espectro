# Plano: PRI-390, tela inicial sem FALHOU falso na verificação de UI

> Deriva da [SPEC](SPEC.md). Este é o **como**; se os dois divergirem, a SPEC vence. Status: proposta
> (16/11/2026). Assume D1 e D2 como recomendadas: fontes das releases oficiais e resposta
> `enabled: false`. Tarefas em [todo.md](todo.md).

## Grafo de dependências

```text
T1 /api/obsidian neutra (server + cliente) ─┐
                                            ├─▶ T3 teste do fixture offline ─▶ T4 /verify-ui real + PR
T2 fontes locais (arquivos + fonts.css)  ───┘
```

T1 e T2 não dependem uma da outra; cada uma fecha uma causa do FALHOU de ponta a ponta. A T3 junta as
duas num teste só, que também protege contra regressão (alguém volta a pôr CDN no `index.html`). A
T4 só faz sentido com as duas causas resolvidas.

## Fatias

**T1, `/api/obsidian` neutra no modo de fixture.** Teste primeiro: em `obsidian-api.test.js`, subir o
`createDashboard` com `PRISMA_DASHBOARD_READONLY=1` e `PRISMA_OBSIDIAN` `on` e `off`, e exigir 200
com o corpo neutro. Sem o modo de fixture, o comportamento de hoje continua. Depois: uma linha no
middleware de `server.js` (~l. 963), ao lado de `/api/claude/usage`, e `obsidian.js` com
`if (s && s.enabled !== false)`. No cliente, um teste de DOM no harness `vm` (padrão do
`nav-ui.test.js`): com `enabled: false` o botão fica escondido; com `{vault, ready, uri}` ele aparece.

**T2, fontes locais.** Baixar `InterVariable.woff2` (e o itálico, se o CSS usar itálico; conferir
antes) e `JetBrainsMono[wght].woff2` das releases oficiais com versão fixa. Gravar o sha256 e a URL
de cada um em `public/fonts/README.md` e copiar o `OFL.txt` de cada projeto. Criar `fonts.css` com
os `@font-face` (`font-weight` em faixa, `font-display: swap`) e trocar as linhas 8–10 do
`index.html` por `<link rel="stylesheet" href="fonts/fonts.css">`. Conferir que o `express.static`
serve `.woff2` como `font/woff2`. Se o `mime` da versão instalada não souber o tipo, registrar o
tipo no static sem trocar dependência.

**T3, teste do fixture offline (AC-1, AC-3).** Criar `ui-fixture-offline.test.js`, que:
(a) lê o `index.html` e as folhas CSS que ele linka (seguindo `@import`) e falha em qualquer
`http(s)://` ou `//` fora de `localhost`/`127.0.0.1` em `href`, `src`, `@import` ou `url()`;
(b) sobe o `createDashboard` com `PRISMA_DASHBOARD_READONLY=1`, faz GET de cada recurso local
referenciado e exige 200, com `font/woff2` para as fontes; (c) exige 200 neutro em
`/api/obsidian`. Registrar o teste no `npm test` do dashboard. Prova de que o teste funciona:
ele falha no `main` atual por causa do Google Fonts.

**T4, `/verify-ui` real e PR (AC-4).** Com `PRISMA_UI_VERIFY=on`, rodar dois casos na tela inicial:
um AC com texto visível que existe (esperado PASSOU) e um com texto que não existe (esperado
FALHOU). Guardar os dois `verdict.json` em `~/Workspace/prisma-evidence/pri-390/`. Acrescentar uma
linha em `docs/ui-verify.md` (a tela não pode depender de rede). Abrir o PR em draft com o rótulo
`processo:medio`, "Refs PRI-390" e a Evidência preenchida. Depois, uma revisão G3 por outro agente
Claude em contexto limpo.

## Pontos de checagem

- **Depois de T1 e T2:** `(cd dashboard && npm test)` verde. Abrir o dashboard local e conferir a olho
  que as fontes não mudaram (Inter no texto, JetBrains Mono nos números).
- **Depois de T3:** o teste novo falha com o `index.html` antigo e passa com o novo.
- **Depois de T4:** os dois vereditos estão anexados e a revisão G3 não deixou nenhum MAJOR aberto.

## Riscos

| Risco | Mitigação |
| --- | --- |
| A fonte local ficar diferente do Google (subset, eixo, itálico) | Usar o arquivo variável completo, e não o subset do Google. Conferir a tela a olho no ponto de checagem |
| `woff2` servido com MIME errado e bloqueado | O teste da T3 exige `font/woff2` |
| Neutralizar a rota esconder bug do Obsidian fora do fixture | O teste da T1 trava o comportamento fora do modo de fixture |
| Outra chamada da tela inicial dar 404 que só o navegador vê | A T4 com navegador real é a prova final. Se surgir uma chamada nova, ela entra no mesmo middleware ou vira pedido de reclassificação |
| Arquivos binários grandes no repo (~400 KB) | Aceitável no dashboard local. O README registra a origem e o hash |

## Fora do plano

Regras do `verdict`, CI, nova dependência npm, ligar flags em consumidor.
