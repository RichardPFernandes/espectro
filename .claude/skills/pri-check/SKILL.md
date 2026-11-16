---
name: pri-check
description: Antes do PR de uma issue PRI, roda a suíte pela receita oficial e a revisão independente por subagente em contexto limpo, no número de revisores do nível.
disable-model-invocation: true
argument-hint: "[PRI-NNN]"
---

# /pri-check

Roda os testes e a revisão do fluxo de desenvolvimento. O nível vem de
`.prisma/level`. Se o arquivo não existir, rode `/pri-start` antes.

## 1. Testes pela receita oficial

Rode a receita da seção "Primeiros passos" do `README.md` (é a mesma da CI), com a
evidência fora de `/tmp`:

```bash
CK="$PWD"; EV="$HOME/Workspace/prisma-evidence/<issue>/$(git rev-parse --short HEAD)"
mkdir -p "$EV/home" "$EV/tmp"
NODEBIN="$(dirname "$(command -v node)")"
for pkg in scripts dashboard; do
  env -i PATH="$NODEBIN:/usr/bin:/bin:/usr/sbin:/sbin" \
    HOME="$EV/home" TMPDIR="$EV/tmp" \
    NODE_OPTIONS="--require=$CK/harness/loopback-only.cjs" \
    PRISMA_ROOT="$CK" REPO_PATH="$CK" \
    npm --prefix "$CK/$pkg" test > "$EV/$pkg.tap" 2>&1
  echo "$pkg exit=$?"
done
grep -hE '^# (tests|pass|fail)' "$EV"/*.tap; grep -h '^not ok' "$EV"/*.tap
```

- Se a mudança só toca um pacote, rode só ele.
- Se só toca docs e skills (`*.md`, `.claude/skills/`), não há suíte para rodar. Diga isso.
- Antes de culpar o diff por uma falha, compare com a `main` numa worktree limpa.
  Não use `git stash`, porque a pilha é compartilhada entre worktrees.
- Falha, timeout ou saída ausente não viram PASS. Registre UNKNOWN com o motivo.
- Detalhes e armadilhas da receita: `.agents/skills/prisma-tests/SKILL.md` e
  `docs/runbook.md`.

## 2. Revisão independente

O revisor é outro agente Claude em contexto limpo. Ele recebe o diff e as fontes,
nunca a sua conclusão.

| Nível | Revisores (Agent tool, em paralelo numa só mensagem) |
| -- | -- |
| Leve | 1: `agent-skills:code-reviewer` |
| Médio | 1 (G3): `agent-skills:code-reviewer` |
| Alto | 2: `agent-skills:code-reviewer` e mais um conforme o risco (`agent-skills:security-auditor` para credencial ou superfície externa, senão `agent-skills:test-engineer`) |

O brief de cada revisor leva:

- o comando do diff (`git diff origin/main...HEAD`);
- a spec (`tasks/<pasta>/SPEC.md`) ou os ACs da issue;
- as regras do `CLAUDE.md` e do `AGENTS.md`;
- o pedido: achados com `arquivo:linha`, classificados como Critical, Required,
  Optional ou Nit, mais um veredito PASS ou FAIL.

O revisor não edita arquivos.

## 3. Depois

- **FAIL:** corrija, rode de novo os testes afetados e devolva só o novo diff ao mesmo
  revisor (SendMessage). Uma segunda rodada completa só com decisão do Richard (regra 6).
- **PASS:** resuma em até 6 linhas: exit de cada suíte, totais, caminho dos TAPs,
  veredito e achados aceitos ou recusados com o motivo. Isso alimenta a Evidência do
  `/pri-pr`.
