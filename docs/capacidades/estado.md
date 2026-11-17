---
id: estado
tipo: base
resumo: Guarda o state.json de cada Run, com um só escritor, versão e lease de nó.
situacao: ligada
spec: sem-spec
flags: []
modulos:
  - scripts/state-writer.js
  - scripts/cas.js
  - scripts/validate-state.js
  - scripts/lib/node-lease.js
  - .graph/schemas/state.schema.json
---

# Estado

Cada Run tem um `state.json`. Só o `state-writer.js` grava nele: a escrita é atômica, sob uma
trava por Run, e a versão do estado sobe quando um campo crítico muda. Antes de uma operação
protegida, o `cas.js` compara o que o chamador leu com o que está no disco e recusa se
divergir. O watcher marca o nó em execução com um lease e, no tick seguinte, recupera o nó
que ficou órfão.

## Por onde começar

1. [`scripts/state-writer.js`](../../scripts/state-writer.js): o único escritor; o comentário do topo explica a escrita e a trava.
2. [`scripts/cas.js`](../../scripts/cas.js): a comparação antes de gravar e os campos exigidos por operação.
3. [`scripts/lib/node-lease.js`](../../scripts/lib/node-lease.js): lease de nó e recuperação de nó órfão.
4. [`scripts/validate-state.js`](../../scripts/validate-state.js): leitura do estado conferida contra o schema.
5. [`docs/concurrency-map.md`](../concurrency-map.md): mapa das operações protegidas e das garantias.
