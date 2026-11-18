---
id: autorizacao
tipo: capacidade
resumo: Pedidos de autorização humana, aprovadores e a admissão do Attempt que autoriza efeito externo.
situacao: ligada
spec: sem-spec
flags: []
modulos:
  - scripts/lib/authorization.js
  - scripts/lib/approvers.js
  - scripts/lib/prisma-config.js
  - scripts/lib/dom06-attempt.js
  - scripts/lib/human-input-intent.js
  - scripts/git-push-effect.sh
---

# Autorização

Hoje só o SQL de banco espera um humano: o `authorization.js` abre o pedido
(`pending_authorization`, tipo `db_migration`) e o `approvers.js` diz quem pode aprová-lo no
dashboard, que não tem login. O `dom06-attempt.js` admite cada Attempt com dono e snapshot presos
e só deixa um efeito correr com autoridade válida, que vem da admissão e não de uma pessoa: a
mesma chave de idempotência não repete o efeito e resultado incerto nunca é repetido sozinho. O
`git-push-effect.sh` é o push do `/commit` sob essa autoridade, sem aprovação humana própria: a
chave leva o repo real e o commit enviado (repos irmãos e commit novo são efeitos distintos), e um
push que falha grava `failed` e sai com o código do git, sem virar entrega; a
autorização humana do Attempt (`escalation`) ainda é só reservada. O `human-input-intent.js` lê a
mensagem humana antes de destravar uma task `blocked`.

O efeito de banco, que usa esse pedido, está em `db-effect`. O AUTORIZO do Richard no processo
de desenvolvimento é outra coisa e não passa por aqui.

## Por onde começar

1. [`scripts/lib/authorization.js`](../../scripts/lib/authorization.js): o pedido, a aprovação e a cópia congelada do artefato.
2. [`scripts/lib/dom06-attempt.js`](../../scripts/lib/dom06-attempt.js): o comentário do topo traz as regras da admissão.
3. [`scripts/lib/approvers.js`](../../scripts/lib/approvers.js): o cadastro de aprovadores.
4. [`scripts/git-push-effect.sh`](../../scripts/git-push-effect.sh): um efeito governado, o menor exemplo.
5. [`docs/consumer-operations.md`](../consumer-operations.md): operações protegidas no consumidor.
