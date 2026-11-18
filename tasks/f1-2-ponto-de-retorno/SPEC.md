# SPEC F1.2: ponto de retorno do consumidor

> **Fatia:** [F1.2](../../roadmap/fase-1-conter-e-enxergar/FASE.md) · **Issue:** PRI-379 · **Nível:** Alto (muda como o consumidor sobe e como o checkout dele volta)
> **AUTORIZO:** pendente · **Flag:** `PRISMA_CHECKOUT_GUARD` (desligada)
> **Decisões citadas:** D3, D8 · **Código lido em:** `main` `8aaaa91` · **Status:** v1, aprovada pelo Richard em 17/11/2026 (Mesa `D-PRI-379-01`)

## Contexto (AS-IS)

- O consumidor roda o Espectro do checkout de trabalho, sem pin. Todo commit, troca de branch ou edição nessa árvore chega a ele (`docs/consumer-operations.md:47`).
- Nada confere a árvore na subida. O dashboard sobe de onde for chamado (`dashboard/server.js:3874`) e o watcher carrega o código do disco a cada tick (`scripts/watcher-manager.js:197`). Em 13/11 o consumidor rodou um worktree fora da `main`.
- O painel Versão só avança: exige alvo na `origin/main` e watcher parado (`dashboard/version.js:96`, `:185`). Não há caminho de volta, e o repo não tem nenhuma tag.
- O launcher do consumidor é arquivo dele, fora deste repo. A única parte comum a todo jeito de subir é o código da plataforma.
- PRI-372: o log de conflitos resolve para o checkout principal quando o teste roda num worktree (`scripts/cas.js:439-451`). Só o #166 foi mesclado, e ele trata outro teste; nenhuma branch corrige o `cas.js`.

## Objetivo

Quando a fatia fecha, existe uma marca de "último verde" no checkout do consumidor, um comando que volta a ela e uma conferência, na subida e a cada tick, que recusa árvore suja ou fora da `main`. A marca só avança depois de uma checagem de saúde, e o resultado fica registrado. Tudo nasce desligado ou sem uso; ligar no consumidor é do Richard.

## Não inclui

- Voltar ao pin (D3; a PRI-371 não segue). Automatizar deploy.
- Editar o launcher ou qualquer arquivo do consumidor. Rodar qualquer comando no checkout vivo.
- Reiniciar o dashboard depois da volta: o comando diz o que falta. Botão de volta no painel Versão.
- Instalar dependências, mexer em `memory/`, estado de Run ou `.env`. Publicar a tag na origem.
- Recusar tick por diferença entre o código em execução e o disco: o painel Versão já mostra.

## Desenho

Um módulo de conferência e uma CLI, `node scripts/return-point.js <status|mark|back> [--root <checkout>]`. A raiz padrão é o checkout onde o script está.

- **Árvore válida:** `git status --porcelain` vazio, contando arquivo não rastreado, e HEAD igual a um commit alcançável pela `origin/main` local. Não faz `fetch`.
- **Marca:** tag anotada `verde/AAAAMMDD-HHMMSS` (UTC), nunca movida nem apagada. "Último verde" é a tag `verde/*` mais recente.
- **`mark`:** roda a checagem de saúde. Se passar, cria a tag no HEAD com o resultado na anotação. Passando ou não, acrescenta uma linha em `logs/return-point.jsonl` da raiz (ignorado pelo git).
- **Checagem de saúde:** árvore válida; o dashboard responde em loopback e o SHA em execução é o HEAD, sem drift; a trava do watcher é legível; nenhum tick caiu desde a subida. Sem tick desde a subida, o item fica `desconhecido` e não reprova.
- **`back`:** leva o HEAD, destacado, ao último verde (`--to verde/<id>` escolhe outro). Não reescreve branch, não faz stash, reset nem clean.
- **Guard:** com `PRISMA_CHECKOUT_GUARD=1`, a subida do dashboard e cada tick do watcher conferem a árvore.

## Critérios de aceite

- AC-01: `return-point.js back` deixa o HEAD no último verde e sai com 0. Sai diferente de 0, sem mudar nada e dizendo o motivo, quando: não há tag verde, a árvore está suja, há watcher, trava ou agente vivo. Se os locks de dependência diferem entre as duas revisões, avisa.
- AC-02: com a flag ligada, o dashboard não abre a porta e sai diferente de 0, e o watcher-manager não inicia o tick e para o laço, quando a árvore está suja ou fora da `main`. A mensagem cita o motivo e até 10 caminhos, e o motivo aparece em `/api/watcher/status`. HEAD destacado numa tag verde passa.
- AC-03: `mark` só cria a tag se a checagem passar. O resultado de cada item, o SHA e a hora ficam na anotação da tag e no log; a reprovação fica só no log, com saída diferente de 0.
- AC-04: o ensaio de volta roda em repositório temporário (marcar, avançar, sujar, recusar, limpar, voltar) e a saída vai para a Evidência do PR. O ensaio no checkout vivo é do Richard, com AUTORIZO, e entra pelo readback.
- AC-05: testes em worktree não gravam no log de conflitos do checkout vivo. Entregue pela PRI-372, em PR próprio; esta fatia não toca `scripts/cas.js` e só fecha com esse PR mesclado e citado.
- AC-06: com a flag ausente, a subida e o tick não executam nenhum comando novo, e os testes atuais do dashboard e do watcher-manager passam sem alteração.
- AC-07: a flag entra em `docs/flags.md` e no `.env.example`, com decisão até 2026-12-18. `docs/consumer-operations.md` passa a descrever o ponto de retorno e fecha a seção "Decisão pendente: DB-13 × checkout" com a D3. Os arquivos novos têm capacidade dona.

## Como se demonstra

- AC-01 a AC-03 e AC-06: testes com `node --test` em repositórios temporários com origem local, escritos antes do código. A checagem de saúde usa um servidor falso em loopback.
- AC-04: saída do ensaio, do `git tag -n` e do log, na Evidência do PR. Depois do AUTORIZO: `/pri-autorizo PRI-379 readback`.
- AC-05: link do PR da PRI-372 e do teste de regressão dela.
- AC-07: `node --test scripts/lib/flag-registry.test.js scripts/capability-map.test.js`.

## Fica ligado?

- Não ao mesclar. O guard fica atrás de `PRISMA_CHECKOUT_GUARD`, e os comandos só rodam quando chamados. Gatilho: o pedido do `/pri-autorizo` lista quatro ações do Richard no consumidor, cada uma com rollback: subir o checkout para a revisão mesclada, o primeiro `mark`, um `back` de ensaio e exportar a flag no launcher. A issue só fecha com o aceite dele.

## Limites

- **Sempre:** testes em repositório temporário; PR em draft com "Refs PRI-379" e `processo:alto`; duas revisões G3 numa rodada só.
- **Perguntar antes:** publicar tags na origem; trocar HEAD destacado por mover a `main` local; qualquer conferência nova na checagem de saúde que leia dado de Run.
- **Nunca:** rodar `mark` ou `back` fora de repositório temporário nesta fatia; ler ou escrever no app-back; gravar fora da raiz dada; pôr na tag ou no log caminho, ticket ou nome do consumidor (D8); apagar ou mover tag; `stash`, `reset` ou `clean`.

## Decisões e riscos

- Decidido em 17/11 (`D-PRI-379-01`, todas com a recomendação): P1, o guard vale na subida e a cada tick; P2, "verde" é a checagem acima, com tick sem dado como `desconhecido`; P3, depois da volta o HEAD fica destacado, e avançar de novo pede `git switch main`; P4, a PRI-372 sai em PR próprio, Médio, antes do PR desta fatia, e esta sessão assume, porque a outra não entregou até o plano.
- Risco: arquivo não rastreado conta como sujeira, e o `pnpm-lock.yaml` solto que aparece nas worktrees faria o guard recusar. O plano dá destino a ele antes de a flag ligar.
