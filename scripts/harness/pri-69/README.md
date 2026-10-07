# Harness PRI-69

Cobre, com processo real, o que a suíte isolada da PRI-61 pulou: filhos destacados, `HOME` temporário e SIGTERM durante o `/implement`.

Cada cenário ganha um diretório temporário com repo git, `HOME` falso, binários `claude`/`codex`/`mvn`/`java` falsos e um HTTP em `127.0.0.1` no lugar de Redmine, Bitbucket e dashboard. O preload `net-guard.js` recusa conexão fora do loopback. Não usa conta, `~/.claude` nem Redmine/Bitbucket reais.

```bash
node scripts/harness/pri-69/run.js
node --test scripts/harness/pri-69/pri-69.e2e.test.js
```

`PRI69_ARTIFACTS` (padrão `scripts/harness/pri-69/artifacts` via `run.js`) recebe, por cenário, o log do watcher, snapshots de `state.json` e `result.json` (`PASS` ou `FAIL`). `PRI69_KEEP=1` conserva a sandbox quando o cenário passa.

Itens: (a) órfão no mesmo nó / commit órfão só escala; (b) SPEC_CHANGE aprovada deixa artefatos STALE e despacha `/plan`; (c) `pending_invalidation` não interrompe o nó em execução; (d)–(h) custo (arquivo, `## Tokens` do codex, `unattributed`, conta `~/.claude-personal`); (i) token de filho sem `--follow` sai `[REDACTED]`; SIGTERM no `/implement` e retomada no mesmo nó e `execution_id`, com no máximo 1 PR.
