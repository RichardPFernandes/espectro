---
id: estado
tipo: base
resumo: Guarda o state.json de cada Run, com um só escritor, versão e lease de nó.
situacao: ligada
spec: viva
flags: []
modulos:
  - scripts/state-writer.js
  - scripts/cas.js
  - scripts/validate-state.js
  - scripts/lib/node-lease.js
  - .graph/schemas/state.schema.json
---

# Estado

Cada Run tem um `state.json`. Só o `state-writer.js` grava nele: a escrita é atômica, sob uma
trava por Run, e a versão do estado sobe quando um campo crítico muda. Antes de uma operação
protegida, o `cas.js` compara o que o chamador leu com o que está no disco e recusa se
divergir. O watcher marca o nó em execução com um lease e, no tick seguinte, recupera o nó
que ficou órfão.

## Propósito

Watcher, dashboard, agentes e CLIs leem e gravam o mesmo `state.json`. A capacidade existe para
que ninguém avance uma Run a partir de uma leitura velha, e para que um arquivo truncado ou
editado à mão vire parada visível, não decisão errada em silêncio.

## Requisitos

| ID | Comportamento | Porquê |
| -- | -- | -- |
| ESTADO-R01 | A escrita troca o arquivo inteiro de uma vez; se o processo cai no meio, vale o estado anterior e a sobra é descartada no startup do watcher. | Meio arquivo quebraria o tick seguinte. |
| ESTADO-R02 | Ler, validar e gravar acontece sob uma trava por Run. Quem não consegue a trava em 5 s recebe `STATE_LOCK_TIMEOUT`; a trava só é quebrada se o dono morreu. | Dono lento que perdesse a trava por idade gravaria junto com o novo dono. |
| ESTADO-R03 | `state_version` sobe 1 por escrita que muda campo crítico (nó, status, sessão, hash e versão da spec, validade dos artefatos, retries). Heartbeat, eventos e custo não sobem. Nenhum chamador mexe na versão. | A versão só deve acusar conflito quando muda o que decide despacho ou contrato. |
| ESTADO-R04 | Campo crítico editado fora do escritor conta como uma versão a mais na leitura seguinte. | Quem leu antes da edição manual precisa falhar na comparação. |
| ESTADO-R05 | Operação protegida informa o que leu (versão, nó, hash da spec, sessão). Se o disco divergir, nada é gravado, o chamador recebe `STATE_CONFLICT` e o evento vai para `logs/state-conflicts.jsonl`. | A decisão foi tomada sobre um estado que não existe mais. |
| ESTADO-R06 | Sessão que não é mais a dona da Run recebe `SESSION_CONFLICT` e não tenta de novo. Agente em `STATE_CONFLICT` relê e tenta uma vez; humano recebe o conflito e recarrega a tela. | Perder a posse não se resolve relendo; o clique humano não pode ser reaplicado sem ele ver o estado novo. |
| ESTADO-R07 | Operação humana com `operation_id` já processado devolve `already_processed`, sem conflito e sem repetir o efeito. | Dois cliques na mesma aprovação são uma aprovação. |
| ESTADO-R08 | Cada tipo de operação protegida tem campos obrigatórios; faltar um é erro de programação, lançado na hora. | Comparação parcial passaria em silêncio. |
| ESTADO-R09 | Escritor com leitura velha não recria Run arquivada nem desfaz campo crítico que outro processo mudou; o que não conflita é reaplicado sobre o estado atual. | Heartbeat atrasado não pode ressuscitar nem regredir uma Run. |
| ESTADO-R10 | Ao despachar, o watcher marca o nó como `running`, com início, prazo e, depois do spawn, o pid do agente. Ao terminar, devolve a `in_progress`, salvo se o comando gravou outro status ou outra sessão assumiu. O lease não é renovado. | É o que permite saber, no tick seguinte, se alguém ainda trabalha no nó. |
| ESTADO-R11 | Nó `running` é órfão quando o agente registrado morreu ou, sem pid, quando passou do prazo. Nó comum volta a `in_progress` e o mesmo nó é redespachado, sem gastar retry. Nó `commit` vai para `needs_human_review`. | O `commit` pode ter feito push ou aberto PR antes de morrer; repetir duplicaria efeito externo. |
| ESTADO-R12 | Estado ilegível ou fora do schema na leitura vira `state_corrupted`, com cópia do arquivo, e espera um humano. A validação é só na leitura. | Antes, o watcher seguia com campos vazios e podia redespachar o início por cima de uma Run em andamento. |

## Invariantes

- ESTADO-I01: só `scripts/state-writer.js` grava `state.json`; um teste varre o código atrás de escrita direta.
- ESTADO-I02: comparação que diverge não grava nada, nem em parte.
- ESTADO-I03: agente vivo nunca é declarado órfão, por mais lento que esteja (seriam dois agentes no mesmo worktree).
- ESTADO-I04: `commit` órfão e estado corrompido nunca são redespachados sozinhos.
- ESTADO-I05: o log de conflitos só leva números, nomes de nó e prefixos de 8 caracteres; nunca segredo, AC ou dado de usuário.

## Flags

Nenhuma flag liga ou desliga esta capacidade. `NODE_TIMEOUT_MS` (padrão 60 min, do p90 medido entre
despachos) é o prazo do lease, e `STATE_CONFLICTS_LOG` muda o caminho do log; são configuração e não
estão em [`docs/flags.md`](../flags.md). Os tempos de trava (5 s de espera, 30 s para trava ilegível) são fixos.

## Por onde começar

1. [`scripts/state-writer.js`](../../scripts/state-writer.js): o único escritor; o comentário do topo explica a escrita e a trava.
2. [`scripts/cas.js`](../../scripts/cas.js): a comparação antes de gravar e os campos exigidos por operação.
3. [`scripts/lib/node-lease.js`](../../scripts/lib/node-lease.js): lease de nó e recuperação de nó órfão.
4. [`scripts/validate-state.js`](../../scripts/validate-state.js): leitura do estado conferida contra o schema.
5. [`docs/concurrency-map.md`](../concurrency-map.md): mapa das operações protegidas e das garantias.
