# SPEC: F1.6, push dos repos irmãos: pulado não vira sucesso (PRI-179)

> **Status:** v1, proposta (18/11/2026), aguardando aprovação do Richard.
> Nível **Alto**: muda `scripts/git-push-effect.sh`, que o `/commit` do consumidor executa a cada
> ticket; chega ao consumidor no bump do checkout, com AUTORIZO próprio e readback.
> Issue: [PRI-179](https://linear.app/prisma-app/issue/PRI-179). Roadmap: F1.6
> (`roadmap/fase-1-conter-e-enxergar/FASE.md`). Entrada: `main` em `42316e9`.

## Objetivo

O `/commit` multi-repo dá push em cada repo tocado chamando `scripts/git-push-effect.sh` de dentro
do repo. O script monta a chave de idempotência do efeito só com os argumentos do git
(`push:push -u origin <branch>`). Todos os repos irmãos usam a mesma branch, então a chave colide:
o primeiro repo faz o push e os outros recebem `DUPLICATE`, saem com código 0 e a mensagem diz
"push já cumprido". O agente lê isso como entrega.

Reprodução em `42316e9`, com dois repos temporários e remotes locais (bare), sem rede:

| Passo | Saída | Remote |
| -- | -- | -- |
| push no repo A | rc=0, push feito | A recebe a branch |
| mesmo push no repo B | rc=0, "push já cumprido", git não roda | B continua sem a branch |
| commit novo no repo A, push de novo | rc=0, "push já cumprido", git não roda | A fica no commit anterior |
| push com remote inexistente | rc=128, nada gravado | — |
| `git-push-effect.sh -C <dir> push …` | rc≠0: o script vira `git push -C …` (`unknown switch`) | — |

A terceira linha é o mesmo defeito por outro caminho: o push da anotação `@spec` (passo 7.5 do
`commit.md`) usa os mesmos argumentos no mesmo repo e também é pulado em silêncio. Ver Q1.

O resultado esperado: cada push que de fato não aconteceu sai com código diferente de 0 ou é um
`DUPLICATE` verdadeiro, isto é, o mesmo conteúdo já entregue no mesmo repo.

## Critérios de aceite

- **AC-1. Identidade do repo na chave.** A chave inclui o caminho canônico do repo: o
  `git rev-parse --show-toplevel` do diretório efetivo, resolvido com `realpath` (symlink e caminho
  relativo dão a mesma identidade). Falha observável: o mesmo `push -u origin <branch>` em dois repos
  temporários deixa o segundo remote sem a branch, ou grava um só efeito.
- **AC-2. Semântica explícita de checkout.** Dois checkouts distintos com a mesma URL de remote são
  dois efeitos (cada checkout é dono do seu push; o git torna inócuo o segundo se o conteúdo for
  igual). Falha observável: o segundo checkout recebe `DUPLICATE`.
- **AC-3. Repetição idêntica continua deduplicada.** Mesmo repo, mesmos argumentos e mesmo commit
  (ver Q1) no mesmo Attempt: o git não roda de novo, a saída é 0 e a linha de pulo diz qual repo e
  qual commit já estavam entregues. Falha observável: um segundo `git push` roda, ou a linha de pulo
  não identifica repo e commit.
- **AC-4. Entrada por cwd e por `-C`.** `git-push-effect.sh push …` usa o cwd;
  `git-push-effect.sh -C <dir> push …` usa `<dir>` para o git e para a identidade. Os dois caminhos
  para o mesmo repo dão a mesma chave. Falha observável: `-C` sai ≠ 0 num repo válido, ou cwd e `-C`
  geram chaves diferentes para o mesmo repo.
- **AC-5. Fora de repo, nada roda.** Se o diretório efetivo não é um repo git, o script sai ≠ 0
  antes de autorizar e sem chamar `git push`. Falha observável: saída 0, ou efeito gravado.
- **AC-6. Push que falha não é entrega.** Se o `git push` sai ≠ 0, o script sai ≠ 0, grava o efeito
  com `status: failed` (repo e código de saída no detalhe) e nunca `fulfilled`. Uma nova tentativa
  com a mesma chave roda o git de novo. Falha observável: saída 0, efeito `fulfilled`, ou
  `DUPLICATE` na nova tentativa.
- **AC-7. Garantias atuais intactas.** Sem `DOM06_ATTEMPT_FILE`, ou com Attempt revogado, o script
  sai 1 sem chamar o git, como hoje. Os testes existentes do DOM06 passam, salvo o ajuste que Q1
  decidir. Falha observável: qualquer teste de `scripts/lib/dom06-*.test.js` vermelho sem decisão.
- **AC-8. Testes sem push real.** Os testes novos usam repos temporários e remotes locais (bare) em
  diretório temporário, com nomes neutros (`repo-a`, `repo-b`, `TICKET-X`). Falha observável: teste
  que usa rede, remote corporativo, número de ticket ou nome de repo do consumidor.

## Limites

**Sempre**
- Mudar só `scripts/git-push-effect.sh`, o teste novo dele e a linha do push em
  `docs/capacidades/autorizacao.md` (spec viva); com Q1 = sim, também o teste da PRI-94. O `dom06-attempt.js` fica como está: a chave é
  responsabilidade de quem chama.
- Evidência no PR: a tabela de reprodução acima rodada antes e depois, e o run da CI.

**Perguntar antes** (decisões pedidas nesta SPEC, com recomendação)
- **Q1. Commit novo no mesmo repo é efeito novo?** Recomendo **sim**: a chave inclui o commit que
  vai ser enviado (`git rev-parse` da origem do refspec, `HEAD` quando a branch é o próprio
  refspec). Sem isso, o push da anotação `@spec` continua pulado e reportado como sucesso. Efeito
  colateral: o teste da PRI-94 em `scripts/lib/dom06-dispatch-env.test.js` hoje afirma que "o
  commit feito depois do primeiro push não chega ao remote"; ele passa a afirmar o contrário, com
  dois efeitos `fulfilled`. Alternativa: manter a chave sem commit e corrigir só repo (AC-1); o
  passo 7.5 fica com o defeito e vira linha nas Agent notes.
- **Q2. Sem flag.** Recomendo **corrigir sem flag**: é defeito com falso sucesso, o comportamento
  atual não tem uso legítimo, e a barreira real é o bump com AUTORIZO e readback. Volta: reverter o
  commit ou voltar o checkout ao commit anterior. Alternativa: flag desligada registrada em
  `docs/flags.md`; o defeito fica vivo no consumidor até um segundo AUTORIZO para ligá-la.
- Qualquer mudança em `.claude/commands/commit.md` (o AC-29 fixa o hash dele) ou no formato do
  arquivo de Attempt.

**Nunca**
- Push em remote real ou corporativo, inclusive para reproduzir.
- Copiar número de ticket, nome de repo ou dado do consumidor para o repo ou para o Linear.
- Bump do checkout vivo sem AUTORIZO do Richard.

## Fora de escopo

- Quais repos irmãos existem (`WATCHER_SIBLING_REPOS`) e quando o push roda.
- Os outros efeitos do `/commit` (PR no Bitbucket, Redmine), que já têm chave própria.
- O bump do checkout e a ligação no consumidor: passo seguinte, com AUTORIZO e readback
  (`/pri-autorizo`).
- Attempts em andamento no momento do bump: uma chave antiga não casa com a nova e o push pode
  rodar mais uma vez; o git trata como "Everything up-to-date". Aceito sem migração.
