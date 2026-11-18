#!/usr/bin/env bash
# Push do /commit sob autoridade do Attempt (PRI-66).
# Não chama `git push` até o Attempt admitido autorizar a obrigação `push`.
# Repetir a mesma chave não faz um segundo push.
# A chave leva o caminho real do repo (PRI-179): o mesmo push em repos irmãos
# são efeitos distintos; cwd, `-C` e symlink para o mesmo repo, a mesma chave.
# A chave leva também o commit enviado (origem do refspec; sem refspec, HEAD):
# commit novo no mesmo repo é efeito novo; o mesmo commit não vai duas vezes.
# Push que falha grava `failed` e sai com o rc do git; a nova tentativa roda de novo.
# Forma que a chave não representa (mais de um refspec, `--tags`, `--all`, `--mirror`,
# `--follow-tags`, `--prune`) sai 2 antes de autorizar (AC-9); `--delete <b>` vale `:<b>`.
#
# Uso (DOM06_ATTEMPT_FILE vem do ambiente do despacho):
#   scripts/git-push-effect.sh [-C <dir>] push -u origin <branch>
# Sem `-C`, o repo é o do cwd. Argumentos depois de `push` são repassados ao
# git. Sem o subcomando, o primeiro argumento já é do git (`-u`, `origin`, ...).
set -euo pipefail

attempt_file="${DOM06_ATTEMPT_FILE:-}"
authorize_js="${DOM06_AUTHORIZE_BIN:-$(cd "$(dirname "$0")/lib" && pwd)/dom06-attempt.js}"
if [[ -z "$attempt_file" || ! -f "$authorize_js" ]]; then
  echo "ERROR: AUTHORITY_INVALID — push sem Attempt DOM06 admitido; git push não rodou." >&2
  exit 1
fi

usage="ERROR: uso: git-push-effect.sh [-C <dir>] [push] <args do git push>"
args=("$@")
dir="$PWD"
if [[ ${#args[@]} -gt 0 && "${args[0]}" == "-C" ]]; then
  if [[ ${#args[@]} -lt 2 ]]; then
    echo "$usage" >&2
    exit 2
  fi
  dir="${args[1]}"
  args=("${args[@]:2}")
fi
if [[ ${#args[@]} -eq 0 ]]; then
  echo "$usage" >&2
  exit 2
fi
if [[ "${args[0]}" != "push" ]]; then
  args=(push "${args[@]}")
fi

# Identidade do repo: toplevel do diretório efetivo, com symlinks resolvidos.
if ! toplevel="$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null)" || [[ -z "$toplevel" ]] \
  || ! repo="$(cd "$toplevel" && pwd -P)"; then
  echo "ERROR: $dir não é um repo git; git push não rodou." >&2
  exit 1
fi

# Commit enviado: origem do refspec depois do remote (sem `+`, antes de `:`);
# sem refspec, HEAD. Remoção (`:branch` ou `--delete branch`) vira `delete`.
# A chave representa um repo, um refspec e um commit: outra forma não roda.
unsupported() {
  echo "ERROR: forma de push não suportada ($1); git push não rodou." >&2
  exit 2
}
positional=()
only_positional=0
skip_next=0
delete=0
for a in "${args[@]:1}"; do
  if [[ "$skip_next" == 1 ]]; then skip_next=0; continue; fi
  if [[ "$only_positional" == 0 ]]; then
    case "$a" in
      --) only_positional=1; continue ;;
      --tags|--all|--branches|--mirror|--follow-tags|--prune) unsupported "$a" ;;
      -d|--delete) delete=1; continue ;;
      -o|--push-option|--repo|--receive-pack|--exec|--recurse-submodules) skip_next=1; continue ;;
      -*) continue ;;
    esac
  fi
  positional+=("$a")
done
if [[ ${#positional[@]} -gt 2 ]]; then
  unsupported "mais de um refspec"
fi
src="HEAD"
if [[ "$delete" == 1 ]]; then
  if [[ ${#positional[@]} -lt 2 ]]; then
    unsupported "--delete sem branch"
  fi
  src=""
elif [[ ${#positional[@]} -eq 2 ]]; then
  refspec="${positional[1]}"
  refspec="${refspec#+}"
  src="${refspec%%:*}"
fi
if [[ -z "$src" ]]; then
  sha="delete"
elif ! sha="$(git -C "$dir" rev-parse --verify --quiet "${src}^{commit}")" || [[ -z "$sha" ]]; then
  echo "ERROR: $src não resolve para um commit em $repo; git push não rodou." >&2
  exit 1
fi

key="push:${repo}@${sha}:${args[*]}"
tmp="$(mktemp)"
set +e
auth_line="$(node "$authorize_js" authorize --attempt "$attempt_file" --obligation push --key "$key" 2>"$tmp")"
auth_rc=$?
set -e
if [[ "$auth_rc" != 0 ]]; then
  cat "$tmp" >&2
  rm -f "$tmp"
  exit 1
fi
if [[ "$auth_line" == DUPLICATE* ]]; then
  echo "push já cumprido neste Attempt: repo $repo, commit $sha já entregue ($key); git push não rodou de novo." >&2
  rm -f "$tmp"
  exit 0
fi
rm -f "$tmp"

# Push que falha não é entrega: grava `failed` (repo e rc) e sai com o rc do git.
# Só `fulfilled` deduplica, então a nova tentativa com a mesma chave roda o git.
set +e
git -C "$dir" "${args[@]}"
push_rc=$?
set -e
if [[ "$push_rc" != 0 ]]; then
  node "$authorize_js" record --attempt "$attempt_file" --obligation push --key "$key" --status failed \
    --detail "push falhou: repo $repo, commit $sha, rc $push_rc ($key)" >/dev/null || true
  echo "ERROR: git push falhou em $repo (rc $push_rc); efeito gravado como failed." >&2
  exit "$push_rc"
fi
node "$authorize_js" record --attempt "$attempt_file" --obligation push --key "$key" --status fulfilled --detail "$key" >/dev/null
