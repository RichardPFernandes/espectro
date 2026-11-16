---
id: db-effect
tipo: capacidade
resumo: Executa, com aprovador humano, um SQL de migração num banco da allowlist e detecta mudança de schema.
situacao: ligada
spec: sem-spec
flags: []
modulos:
  - scripts/lib/db-effect.js
  - scripts/lib/db-exec-child.js
  - scripts/lib/db-targets.js
  - scripts/lib/sql-lexer.js
  - scripts/lib/schema-watcher.js
---

# Efeito de banco

O `db-effect` executa um artefato SQL (`pending_authorization` do tipo `db_migration`) num banco
compartilhado, e só a partir da cópia congelada na aprovação pelo dashboard. Quem chama é o
`authorization.js`; não há CLI de execução. A allowlist de bancos fica só em
`~/.config/prisma/db-targets.json` e a senha só no Keychain, lida pelo processo filho
(`db-exec-child.js`). O `sql-lexer.js` confere o SQL por tokens, não por regex, e um desfecho
incerto fica `UNCERTAIN` e nunca é repetido sozinho. O `schema-watcher.js` é outra coisa: detecta
mudança de schema no diff do ticket e gera a checklist de migração.

## Por onde começar

1. [`scripts/lib/db-effect.js`](../../scripts/lib/db-effect.js): o comentário do topo traz o modelo de ameaça e as regras.
2. [`scripts/lib/sql-lexer.js`](../../scripts/lib/sql-lexer.js): o que o tokenizer aceita e recusa.
3. [`scripts/lib/db-targets.js`](../../scripts/lib/db-targets.js): o cadastro da allowlist e do segredo.
4. [`scripts/lib/authorization.js`](../../scripts/lib/authorization.js): quem chama e quando (capacidade `autorizacao`).
5. [`scripts/lib/schema-watcher.js`](../../scripts/lib/schema-watcher.js): a checklist de migração.
