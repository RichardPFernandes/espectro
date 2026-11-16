---
name: pri-autorizo
description: Prepara o pedido de AUTORIZO de uma issue PRI Alto (go/no-go, rollback, readback) e, depois do bump, faz o readback. Substitui o /agent-skills:ship neste repo.
disable-model-invocation: true
argument-hint: "PRI-NNN [readback]"
---

# /pri-autorizo

Só para nível Alto, depois do `/pri-pr` com a revisão PASS. Não abre revisores
novos: os relatórios do `/pri-check` já são a rodada G3 (regra 6).

## Pedido (sem argumento extra)

Monte, a partir do PR, da SPEC e dos relatórios do `/pri-check`:

- **Go/no-go**, com os bloqueios que restam (Critical e Required abertos, CI vermelha).
- **O que muda no consumidor:** flag, bump do checkout, polling ou credencial, com o
  valor de antes e o de depois.
- **Rollback:** o gatilho (sinal observável), os passos exatos e o tempo esperado.
- **Readback:** o que ler depois do bump para provar que entrou e que nada regrediu,
  com comando ou fonte e o resultado esperado.

Grave isso nas seções `## Rollback` e `## Readback` do corpo do PR. Na issue, deixe
um comentário de 3 linhas: Bloqueio / AUTORIZO do Richard para <ação> / Efeito.
Atualize o bloco de Estado. Não execute nada no consumidor.

## Readback (`/pri-autorizo PRI-NNN readback`)

Só depois do AUTORIZO explícito e do bump feito. Rode cada item do Readback e
registre o resultado (PASS, FAIL ou UNKNOWN, com a prova) na seção Evidência do
PR. Em qualquer FAIL, pare: deixe um comentário de bloqueio com o rollback proposto e
não execute nada no consumidor. O rollback também precisa de AUTORIZO, salvo se o
pedido original o incluía de forma explícita. A issue continua em In Review até o
aceite do Richard.
