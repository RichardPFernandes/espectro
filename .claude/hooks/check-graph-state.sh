#!/usr/bin/env bash
# PreToolUse hook (matcher: Bash). Bloqueia `git commit` se existir uma task ativa em
# memory/runs/ cujo nó ainda não chegou em "verify"/"commit". Heurística simples —
# não substitui o julgamento dos nós Review/Verify, só evita o caso óbvio de
# commitar no meio do ciclo. Ajuste conforme a necessidade real do projeto.

input=$(cat)
cmd=$(echo "$input" | jq -r '.tool_input.command // empty')

case "$cmd" in
  *"git commit"*) ;;
  *) exit 0 ;;
esac

runs_dir="${CLAUDE_PROJECT_DIR:-.}/memory/runs"
[ -d "$runs_dir" ] || exit 0

for state_file in "$runs_dir"/*/state.json; do
  [ -f "$state_file" ] || continue
  node=$(jq -r '.node // empty' "$state_file")
  status=$(jq -r '.status // empty' "$state_file")
  if [ "$status" != "committed" ] && { [ "$node" = "plan" ] || [ "$node" = "implement" ]; }; then
    task_id=$(jq -r '.task_id // "?"' "$state_file")
    echo "Task '$task_id' ainda está no nó '$node' — rode /review, /test e /verify antes de commitar." >&2
    exit 2
  fi
done

exit 0
