#!/usr/bin/env bash
# Abre um PR no Bitbucket Cloud via API, sempre com o mesmo request testado e
# validado ao vivo (ticket #43509, 2026-09-11): Authorization: Bearer com API
# token da Atlassian (ATATT...). Basic Auth com esse tipo de token pode
# retornar 401/403 dependendo do endpoint; Bearer é o que funciona pros
# escopos de repository/pullrequest que os tokens deste projeto têm.
#
# Existe pra parar de deixar cada agente/sessão remontar o curl na mão a
# partir de instruções em prosa (commit.md) — foi exatamente essa remontagem
# manual que causou um diagnóstico errado de "token inválido" numa sessão
# anterior.
#
# Uso:
#   BITBUCKET_WORKSPACE=... BITBUCKET_API_TOKEN=... \
#     scripts/bitbucket-open-pr.sh [--no-draft] [--title-prefix <texto>] \
#       <repo> <source_branch> <dest_branch> <title> <<'EOF'
#   descrição do PR (multi-linha, lida do stdin)
#   EOF
#
# Draft por padrão (desde 2026-09-24, Task 51): TODO PR abre com "draft": true no
# payload, independente de risk_level — o dev testa no preview de ambiente e só
# então marca como pronto pelo dashboard (POST /api/pr/<ticket>/ready). Draft
# impede merge acidental, não impede push.
#
# Opcionais (podem vir antes ou depois dos posicionais):
#   --draft                 aceito por compatibilidade (é o padrão; o /commit de
#                           risk_level "high" ainda passa) — não muda nada.
#   --no-draft              abre já pronto pra revisão (uso manual; o ciclo do
#                           grafo nunca passa isto).
#   --title-prefix <texto>  prefixa o título com "[<texto>] " (ex:
#                           --title-prefix HIGH-RISK => "[HIGH-RISK] Problema
#                           #43425 - ...") — usado pelo /commit quando
#                           state.json.risk_level == "high".
#
# Reviewers default: PR criado pela API NÃO recebe os default reviewers do repo
# (o Bitbucket só aplica isso na UI). Por isso o script busca
# GET .../effective-default-reviewers e manda em "reviewers". O autor (dono do
# token) não pode ser reviewer — o Bitbucket responde 400 — então ele sai da
# lista: por BITBUCKET_ACCOUNT_ID, ou GET /2.0/user (exige o escopo
# read:user:bitbucket); sem nenhum dos dois, se o POST voltar 400 "is the author
# and cannot be included as a reviewer", tira o reviewer citado e tenta uma vez
# mais. Falha ao buscar os reviewers nunca impede o PR: abre sem e avisa no stderr.
#
# Requer no ambiente: BITBUCKET_WORKSPACE, BITBUCKET_API_TOKEN.
# Opcionais: BITBUCKET_ACCOUNT_ID (ver acima), BITBUCKET_API_BASE (padrão
# https://api.bitbucket.org/2.0; só pra teste).
# BITBUCKET_EMAIL não é usado aqui (só existiria pra Basic Auth, que este
# script não usa).
#
# Saída em sucesso (exit 0): imprime só a URL html do PR na última linha de
# stdout (fácil de capturar com $(...)); detalhes completos (id incluso) vão
# pra stderr.
# Saída em falha (exit 1): imprime "ERROR: HTTP <status> - <body>" em stderr.
# Nunca loga o valor do token.

set -euo pipefail

draft=true
title_prefix=""
positional=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --draft) draft=true; shift ;;
    --no-draft) draft=false; shift ;;
    --title-prefix)
      [[ $# -ge 2 ]] || { echo "ERROR: --title-prefix exige um valor" >&2; exit 1; }
      title_prefix="$2"; shift 2 ;;
    --title-prefix=*) title_prefix="${1#*=}"; shift ;;
    --) shift; positional+=("$@"); break ;;
    -*) echo "ERROR: opção desconhecida: $1" >&2; exit 1 ;;
    *) positional+=("$1"); shift ;;
  esac
done
set -- "${positional[@]+"${positional[@]}"}"

repo="${1:?uso: bitbucket-open-pr.sh [--no-draft] [--title-prefix <texto>] <repo> <source_branch> <dest_branch> <title>, descrição via stdin}"
source_branch="${2:?source_branch obrigatório}"
dest_branch="${3:?dest_branch obrigatório}"
title="${4:?title obrigatório}"
if [[ -n "$title_prefix" ]]; then
  title="[$title_prefix] $title"
fi

# Carrega .env do consumidor (REPO_PATH explícito, senão cwd do consumidor),
# preservando a precedência de BITBUCKET_* do loader original.
consumer_root="${REPO_PATH:-$PWD}"
env_file="$consumer_root/.env"
if [[ -f "$env_file" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
fi

: "${BITBUCKET_WORKSPACE:?defina BITBUCKET_WORKSPACE no ambiente ou em .env}"
: "${BITBUCKET_API_TOKEN:?defina BITBUCKET_API_TOKEN no ambiente ou em .env}"

description="$(cat)"
api_base="${BITBUCKET_API_BASE:-https://api.bitbucket.org/2.0}"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

# GET autenticado; escreve o corpo em $1 e devolve o HTTP status no stdout.
bb_get() {
  curl -s -o "$1" -w '%{http_code}' -H "Authorization: Bearer $BITBUCKET_API_TOKEN" -H "Accept: application/json" "$2" || echo 000
}

# Reviewers default efetivos do repo (repo + projeto), paginado.
reviewers='[]'
next_url="$api_base/repositories/$BITBUCKET_WORKSPACE/$repo/effective-default-reviewers?pagelen=100"
while [[ -n "$next_url" ]]; do
  status="$(bb_get "$tmp_dir/dr.json" "$next_url")"
  if [[ "$status" != 2* ]]; then
    echo "WARN: não deu pra buscar os default reviewers de $repo (HTTP $status); PR abre sem reviewers" >&2
    reviewers='[]'
    break
  fi
  reviewers="$(jq -c --argjson acc "$reviewers" '$acc + [.values[]? | .user | select(.account_id != null) | {account_id, display_name}]' "$tmp_dir/dr.json")"
  next_url="$(jq -r '.next // empty' "$tmp_dir/dr.json")"
done

# Dono do token, pra sair da lista (autor não pode ser reviewer).
me="${BITBUCKET_ACCOUNT_ID:-}"
if [[ -z "$me" && "$reviewers" != '[]' ]]; then
  if [[ "$(bb_get "$tmp_dir/me.json" "$api_base/user")" == 2* ]]; then
    me="$(jq -r '.account_id // empty' "$tmp_dir/me.json")"
  fi
fi
if [[ -n "$me" ]]; then
  reviewers="$(jq -c --arg me "$me" 'map(select(.account_id != $me))' <<<"$reviewers")"
fi

build_payload() {
  jq -n \
  --arg title "$title" \
  --arg desc "$description" \
  --arg src "$source_branch" \
  --arg dst "$dest_branch" \
  --argjson draft "$draft" \
  --argjson reviewers "$reviewers" \
  '{title: $title, description: $desc, source: {branch: {name: $src}}, destination: {branch: {name: $dst}}, close_source_branch: false}
   + {draft: $draft, reviewers: ($reviewers | map({account_id}))}'
}

response_file="$tmp_dir/response.json"
post_pr() {
  build_payload > "$tmp_dir/payload.json"
  curl -s -o "$response_file" -w '%{http_code}' \
    -X POST \
    -H "Authorization: Bearer $BITBUCKET_API_TOKEN" \
    -H "Content-Type: application/json" \
    "$api_base/repositories/$BITBUCKET_WORKSPACE/$repo/pullrequests" \
    -d @"$tmp_dir/payload.json"
}

http_status="$(post_pr)"

# Sem identidade conhecida, o autor pode ter ido na lista: o Bitbucket devolve
# 400 "<Nome> is the author and cannot be included as a reviewer". Tira quem
# for citado e tenta uma vez.
if [[ "$http_status" == 400 ]] && grep -q 'cannot be included as a reviewer' "$response_file"; then
  err_msg="$(jq -r '[.. | strings] | join(" ")' "$response_file" 2>/dev/null || cat "$response_file")"
  without_author="$(jq -c --arg msg "$err_msg" 'map(select(.display_name as $n | ($n == null) or ($msg | contains($n + " is the author") | not)))' <<<"$reviewers")"
  if [[ "$without_author" != "$reviewers" ]]; then
    reviewers="$without_author"
    http_status="$(post_pr)"
  fi
fi

if [[ "$http_status" != 2* ]]; then
  echo "ERROR: HTTP $http_status - $(cat "$response_file")" >&2
  exit 1
fi

id="$(jq -r '.id' "$response_file")"
url="$(jq -r '.links.html.href' "$response_file")"
echo "PR #$id aberto em $repo ($source_branch -> $dest_branch): $url" >&2
echo "Reviewers: $(jq -r '[.reviewers[]?.display_name] | if length == 0 then "nenhum" else join(", ") end' "$response_file")" >&2
echo "$url"
