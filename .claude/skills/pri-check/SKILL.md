---
name: pri-check
description: Antes do PR de uma issue PRI, roda as checagens e a suíte pela receita oficial e a revisão independente por subagente em contexto limpo, no número de revisores do nível.
disable-model-invocation: true
argument-hint: "PRI-NNN"
---

# /pri-check

Roda testes e revisão do fluxo de desenvolvimento. `<issue>` é o argumento
(`$ARGUMENTS`, ex.: `pri-376`). O nível vem de `.prisma/level`. Se o arquivo
não existir, rode `/pri-start` antes.

Comece com a árvore limpa (`git status --porcelain` vazio): a evidência fica
ligada ao SHA do HEAD e não pode carregar alteração fora do commit.

## 1. Testes pela receita oficial

Se a mudança só toca docs e skills (`*.md`, `.claude/skills/`), não há suíte para
rodar. Diga isso e vá para a revisão. Se toca código, rode a receita da seção
"Primeiros passos" do `README.md`, que é a mesma da CI:

```bash
npm ci --ignore-scripts --no-audit --no-fund --prefix scripts
npm ci --ignore-scripts --no-audit --no-fund --prefix dashboard
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
npm --prefix scripts run check:js && npm --prefix scripts run arch:check; echo "checks exit=$?"
```

- Uma worktree nova não tem `node_modules`. Sem o `npm ci`, a suíte falha e a
  comparação com a `main` falha igual.
- Antes de culpar o diff por uma falha, compare com a `main` numa worktree limpa.
  Não use `git stash`, porque a pilha é compartilhada entre worktrees.
- Falha, timeout ou saída ausente não viram PASS. Registre UNKNOWN com o motivo.

## 2. Revisão independente

O revisor é outro agente Claude em contexto limpo. Ele recebe o diff e as fontes,
nunca a sua conclusão. Esta é a única rodada (regra 6).

| Nível | Revisores (Agent tool, em paralelo numa só mensagem) |
| -- | -- |
| Leve | 1: `agent-skills:code-reviewer` |
| Médio | 1 (G3): `agent-skills:code-reviewer` |
| Alto | 2: `agent-skills:code-reviewer` e mais um conforme o risco (`agent-skills:security-auditor` para credencial ou superfície externa, senão `agent-skills:test-engineer`) |

O brief de cada revisor leva:

- o comando do diff (`git diff -M origin/main...HEAD`);
- a spec (`<pasta>/SPEC.md`) ou os ACs da issue;
- as regras do `CLAUDE.md` e do `AGENTS.md`;
- o pedido: achados com `arquivo:linha`, classificados como Critical, Required,
  Optional ou Nit, mais um veredito PASS ou FAIL.

O revisor não edita arquivos.

## 3. Depois

- **FAIL:** corrija, rode de novo os testes afetados e devolva só o novo diff ao mesmo
  revisor (SendMessage), para ele conferir as correções. Isso não é uma segunda rodada.
- **PASS:** resuma em até 6 linhas: exit de cada suíte e das checagens, totais,
  caminho dos TAPs, veredito, e achados aceitos ou recusados com o motivo. Isso
  alimenta a Evidência do `/pri-pr`.
