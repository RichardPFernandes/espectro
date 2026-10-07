#!/usr/bin/env bash
# Push do /commit sob autoridade do Attempt (PRI-66).
# Não chama git até o Attempt admitido autorizar a obrigação `push`.
# Repetir a mesma chave não faz um segundo push.
#
# Uso (DOM06_ATTEMPT_FILE vem do ambiente do despacho):
#   scripts/git-push-effect.sh push -u origin <branch>
# Argumentos depois de `push` são repassados ao git. Sem o subcomando, o
# primeiro argumento já é do git (`-u`, `origin`, ...).
set -euo pipefail

attempt_file="${DOM06_ATTEMPT_FILE:-}"
authorize_js="${DOM06_AUTHORIZE_BIN:-$(cd "$(dirname "$0")/lib" && pwd)/dom06-attempt.js}"
if [[ -z "$attempt_file" || ! -f "$authorize_js" ]]; then
  echo "ERROR: AUTHORITY_INVALID — push sem Attempt DOM06 admitido; git push não rodou." >&2
  exit 1
fi

args=("$@")
if [[ ${#args[@]} -eq 0 ]]; then
  echo "ERROR: uso: git-push-effect.sh [push] <args do git push>" >&2
  exit 2
fi
if [[ "${args[0]}" != "push" ]]; then
  args=(push "${args[@]}")
fi

key="push:${args[*]}"
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
  echo "push já cumprido neste Attempt ($key); git push não rodou de novo." >&2
  rm -f "$tmp"
  exit 0
fi
rm -f "$tmp"

git "${args[@]}"
node "$authorize_js" record --attempt "$attempt_file" --obligation push --key "$key" --status fulfilled --detail "$key" >/dev/null
