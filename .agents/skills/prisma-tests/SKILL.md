---
name: prisma-tests
description: Roda a receita oficial de testes do Prisma (pacotes scripts/ e dashboard/ via harness/run-tests.js, com HOME/TMPDIR sintéticos e loopback-only) e resume falhas. Use depois de editar código do Prisma, antes de pedir review ou commit.
---

# prisma-tests

Receita completa em `docs/runbook.md`, seção "Testes dos pacotes (receita oficial)". Ela vence esta skill em caso de divergência.

O Prisma tem dois pacotes Node independentes (`scripts/`, `dashboard/`) e nenhum runner na raiz. `npm test` puro falha de propósito: o harness exige `REPO_PATH`/`PRISMA_ROOT` absolutos.

## Comando

Rode a partir da raiz do checkout em que você está trabalhando (worktree descartável, nunca o consumidor ativo). Dependências devem estar instaladas pelos locks (`npm ci --prefix scripts`, `npm ci --prefix dashboard`).

```bash
CK="$PWD"; EV="$(mktemp -d)"; mkdir -p "$EV/home" "$EV/tmp"
NODEBIN="$(dirname "$(command -v node)")"
run_suite() {
  env -i PATH="$NODEBIN:/usr/bin:/bin:/usr/sbin:/sbin" \
    HOME="$EV/home" TMPDIR="$EV/tmp" \
    NODE_OPTIONS="--require=$CK/harness/loopback-only.cjs" \
    PRISMA_ROOT="$CK" REPO_PATH="$CK" \
    npm --prefix "$CK/$1" test > "$EV/$1.tap" 2>&1
}
run_suite scripts; echo "scripts exit=$?"
run_suite dashboard; echo "dashboard exit=$?"
grep -hE '^# (tests|pass|fail)' "$EV"/*.tap; grep -h '^not ok' "$EV"/*.tap
```

Se a mudança for localizada num pacote, rode só a suíte dele.

## Regras

- Compare com a `main`: antes de atribuir uma falha à sua mudança, confira se ela já falha sem o seu diff (`git stash -u` ou outro worktree).
- Teste novo entra na lista explícita do script `test` do `package.json` do pacote; o runner não descobre arquivos sozinho.
- Relate: node/npm usados, HEAD, se a árvore tinha diff, totais por suíte e cada `not ok` com arquivo e mensagem.
- Resultado desta sessão não é evidência oficial do ciclo (ver `.cursor/rules/interactive-boundary.mdc`).
