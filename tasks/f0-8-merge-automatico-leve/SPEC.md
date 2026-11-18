# SPEC F0.8: Merge automático do Leve

> **Fatia:** [F0.8](../../roadmap/fase-0-destravar/FASE.md) · **Issue:** PRI-410 · **Nível:** Alto (muda uma regra fixa do Acordo e dá a um bot o poder de mesclar na `main`)
> **AUTORIZO:** pendente · **Flag:** variável de repositório `MERGE_LEVE` (ausente = só simula)
> **Decisões citadas:** D12 · **Código lido em:** `main` `bc9407a`

## Contexto (AS-IS)

- O merge é sempre do Richard (`CLAUDE.md:11`, `AGENTS.md:57`), mesmo no Leve, onde mesclar já é aceitar (D12).
- O `processo-check` lê script, limites e template da base do PR, para que um PR não afrouxe a própria barreira (`.github/workflows/processo-check.yml:25-29`).
- O ruleset `main` exige os checks `Node 22`, `Node 24` e `processo-check`, sem revisão obrigatória e sem bypass. O `Static checks` não é obrigatório. `allow_auto_merge` está desligado e o token padrão do Actions é só leitura (lido via `gh api` em 18/11).
- O runtime lê arquivos fora de `scripts/`: `docs/flags.md` (`scripts/lib/flag-registry.js:16`), `templates/` (`scripts/lib/spec-template.js`), JSONs de `tasks/` (`scripts/lib/model-routing.js:390`) e os cabeçalhos de `docs/capacidades/` (usados pelo próprio `processo-check`).
- Um push feito com o `GITHUB_TOKEN` não dispara outros workflows: o `roadmap-pages` (`.github/workflows/roadmap-pages.yml:6-14`) não publicaria depois de um merge do bot.

## Objetivo

Um PR com `processo:leve`, fora de draft, com todos os checks verdes e só caminhos da lista mescla sozinho pelo bot do Actions. Qualquer outro PR continua esperando o Richard. Um comentário diário lista o que entrou.

## Não inclui

- Médio e Alto. Caminhos que rodam numa Run ou mudam a barreira (lista em (b)).
- Mudar o ruleset ou a branch protection. Mesclar PR de fork.
- Levar o resumo ao Linear (fica para a F0.9, que já monta o relatório semanal).

## Decisões para o Richard (cada uma com recomendação)

**(a) Texto da exceção.** Recomendo trocar a regra 10 do `CLAUDE.md` por: "Merge é sempre do Richard, com uma exceção: com `MERGE_LEVE` ligado, o bot do GitHub Actions mescla o PR `processo:leve`, fora de draft, que só toca caminhos da lista `mergeLeve` de `.github/processo.json` na `main` e tem todos os checks verdes. Agente nunca mescla. Fora disso, PR em draft. Use "Refs", nunca "Fixes"." No `AGENTS.md`, a linha de "O que nunca muda" passa a: "PR em draft e merge do Richard; a única exceção é o merge automático do Leve pelo bot (regra 10 do `CLAUDE.md`). Agente nunca mescla. Use "Refs", nunca "Fixes"." O `/pri-pr` abre fora de draft só o Leve que já cabe na lista.

**(b) Lista de caminhos.** Recomendo uma lista curta, em `.github/processo.json` (chave `mergeLeve`), lida da `main` na hora de avaliar. A negação vence a permissão.
- Permitido: `ROADMAP.md`, `README.md`, `roadmap/**/*.md`, `docs/**/*.md`, `tasks/**/*.md`, `**/*.test.js`, `**/*.test.mjs`.
- Negado: `.github/**`, `.claude/**`, `CLAUDE.md`, `AGENTS.md`, `docs/capacidades/**`, `docs/flags.md`, `docs/handoff-contract.md`, `docs/migrations/**`, `templates/**`, `**/fixtures/**`, `**/package*.json`, lockfiles.
- Arquivo removido ou renomeado só é permitido em `.md`: apagar teste continua com o Richard.
- Ficam de fora, de propósito, `scripts/` e `dashboard/` de produção, `harness/`, `tools/` e `.env.example`.

**(c) Como o bot mescla.** Recomendo um workflow próprio, `.github/workflows/merge-leve.yml`, e não o auto-merge do GitHub. O auto-merge, uma vez ligado no PR, sobrevive a pushes novos, e um commit posterior com caminho proibido mesclaria sem nova avaliação. O workflow roda em `workflow_run` (fim do `Tests` e do `processo-check`). Esse evento sempre executa o arquivo da `main`, nunca o do PR. O workflow não faz checkout do código do PR: lê a lista da `main` e os arquivos do PR pela API. Ele mescla com `PUT /pulls/{n}/merge` (squash), passando o `sha` avaliado; se entrou commit depois, o GitHub recusa e a próxima rodada reavalia. Permissões do job: `contents: write`, `pull-requests: write`, `actions: write` (só para disparar o `roadmap-pages` por `workflow_dispatch` quando o PR tocar `roadmap/` ou `ROADMAP.md`). Os demais jobs seguem só leitura. Três barreiras impedem um PR de mudar a própria lista ou o próprio workflow: o `workflow_run` usa o arquivo da `main`; a lista vem da `main`; e `.github/**` está negado, então o PR que mexe em qualquer um dos dois nunca é elegível. O ruleset continua exigindo os checks também para o bot, sem bypass.

**(d) Resumo diário.** Recomendo uma issue fixa do GitHub, "Merge automático do Leve: resumo", com um comentário por dia (cron às 08:00 BRT, `issues: write`). O comentário lista os PRs mesclados pelo bot nas últimas 24 h (número, título, issue citada) e os PRs Leve que ficaram de fora, com o motivo. Dia sem merge não comenta. Não precisa de credencial nova, e o Richard recebe a notificação do GitHub. O repo é público, mas o conteúdo são títulos de PR que já são públicos.

**(e) O que precisa de AUTORIZO.** Recomendo deixar "Allow auto-merge" desligado: com (c), ele não é usado. O workflow entra pelo merge do PR desta fatia (merge do Richard) em modo de simulação: sem `MERGE_LEVE=on`, ele só escreve no resumo do job "mesclaria #N" ou "não: <motivo>". O AUTORIZO é para gravar a variável `MERGE_LEVE=on`. Ruleset, branch protection e permissões padrão do Actions não mudam.

## Critérios de aceite

- AC-01: a lista é lida da `main`, não do PR. Falha observável: um PR que acrescenta um caminho à lista fica de fora, e um teste da função de elegibilidade com lista da base ≠ lista do head usa a da base.
- AC-02: um PR que toca caminho fora da lista não mescla sozinho, mesmo com `processo:leve`. Falha observável: um PR de teste rotulado Leve que toca `scripts/` continua aberto, com o motivo no resumo do job.
- AC-03: um resumo diário lista o que entrou. Falha observável: depois de um merge do bot, não aparece comentário na issue fixa no dia seguinte.
- AC-04: sem `MERGE_LEVE=on`, nada é mesclado e o resumo do job diz o que seria mesclado. Falha observável: um merge feito pelo bot com a variável ausente.
- AC-05: PR em draft, de fork, com check vermelho ou pendente, ou com o rótulo `segurar` não mescla.

## Delta de capacidade

Nenhum. `.github/` não tem capacidade dona (`node scripts/capability-map.js --of .github/workflows/tests.yml`), e nada que roda numa Run muda.

## Como se demonstra

- AC-01, AC-02, AC-05: testes da função pura de elegibilidade (`.github/scripts/merge-leve.test.mjs`), no mesmo molde do `processo-lib`; e, em simulação, as linhas "mesclaria" e "não: <motivo>" no resumo do job para dois PRs de teste.
- AC-03: link do comentário na issue fixa (via `workflow_dispatch` antes do AUTORIZO e pelo cron depois).
- AC-04: run em simulação sobre um PR elegível, com o PR ainda aberto.

## Fica ligado?

Sim: o workflow fica ativo em simulação no merge do PR, e mescla de verdade depois do AUTORIZO e de `MERGE_LEVE=on`.

## Rollback

1. Apagar a variável `MERGE_LEVE`, ou gravar `off`: o workflow volta a só simular na rodada seguinte.
2. Se preciso, `gh workflow disable merge-leve.yml`.
3. Um merge indevido se desfaz com PR de revert, mesclado pelo Richard.
4. O texto da exceção sai num PR que reverte o desta fatia.

## Readback

Depois do AUTORIZO: `gh variable get MERGE_LEVE` = `on`; `allow_auto_merge` = `false`; o ruleset `main` sem mudança; o primeiro PR Leve elegível mesclado por `github-actions[bot]`; um PR Leve de teste que toca `scripts/` continua aberto; e o comentário do dia seguinte na issue fixa.

## Riscos e perguntas abertas

- Rótulo Leve errado: a lista só admite markdown e teste, então o pior caso é doc ou teste fraco entrar sem o Richard ver. O resumo diário é onde ele percebe isso.
- Teste afrouxado entra sem revisão: apagar teste fica de fora; editar teste entra. Se o Richard preferir, `**/*.test.*` sai da lista (pergunta, recomendação: manter).
- A issue fixa do GitHub é canal novo. Alternativa: comentar no Linear, o que exige guardar um token do Linear no Actions (credencial, mais um AUTORIZO). Recomendação: GitHub agora e Linear pela F0.9.
- A linha da F0.8 em `roadmap/fase-0-destravar/FASE.md:41` ainda diz "sem issue": a correção para PRI-410 vai no PR da fatia.
