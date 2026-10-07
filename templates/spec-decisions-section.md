<!--
Template da seção "## Decisões de Implementação" da spec (memory/spec/<id>-spec.md).

Quem escreve: o nó /implement (passo "Spec como contrato vivo" de
.claude/commands/implement.md). Quem lê: o /review (divergência coberta por uma
entrada daqui = intencional) e o dashboard (badge "spec atualizada").

Regras:
- SÓ APPEND. Nunca reescreva, reordene nem apague entradas ou outras seções da spec
  (Problema, Solução, Critérios de Aceite, Restrições...). O texto original do
  critério fica como está (é o /commit que registra correções com data, ver
  .claude/commands/commit.md).
- SPEC = WHAT. Esta seção registra HOW (ambiguidade resolvida, restrição técnica) e
  fica FORA do spec_hash (scripts/lib/spec-authority.js) por isso. Entrada cujo
  "Impacto no spec" cita um AC ("AC-03 ajustado", "critério") é mudança de WHAT e NÃO
  se autoriza sozinha: sem SPEC_CHANGE aprovado por humano (state.json
  spec_change_approved=true + spec_change_hash=hash atual da spec) o /verify reprova
  (BEHAVIOR_CHANGE_WITHOUT_APPROVAL). Impacto começando com "Nenhum" não altera AC.
- A seção fica no FIM da spec. Se ainda não existir, crie o cabeçalho
  "## Decisões de Implementação" uma única vez; depois, só acrescente blocos "###".
- Uma entrada por rodada de implement que tomou decisão (implement pode rodar de novo
  depois de reprovação no review — cada rodada ganha o seu bloco, com o próprio
  timestamp). Vários itens da mesma rodada ficam no mesmo bloco, um trio de bullets
  por decisão.
- Registre só o que muda comportamento observável ou o contrato da entrega:
  divergência da spec, ambiguidade da spec resolvida, restrição técnica que a spec não
  previa. Refactor interno, nome de variável, escolha de lib sem efeito visível: não.
- Nenhuma decisão significativa na rodada => não toque a spec.
- Não copie este comentário para a spec — copie só o bloco abaixo, preenchido.

Campos:
- Cabeçalho "###": "implement · <timestamp UTC ISO-8601, o mesmo do updated_at que
  você grava no state.json> · <task-id>".
- Decisão: o que foi feito, concreto (classe/campo/regra), em uma frase.
- Motivo: por que, em uma frase (a restrição técnica, a ambiguidade, o dado real).
- Impacto no spec: "Nenhum critério alterado — resolve ambiguidade de <trecho>" (o
  caso normal), "Restrições: acrescenta <restrição técnica>", ou — só com SPEC_CHANGE
  aprovado — o ID estável do critério ("AC-03 ajustado: ..."). Spec antiga sem IDs:
  "Critério de aceite #3".
-->

## Decisões de Implementação

### implement · 2026-09-24T14:05Z · 12345
- **Decisão**: usar `BigDecimal` em vez de `double` para cálculo de valor
- **Motivo**: precisão necessária para valores monetários
- **Impacto no spec**: Nenhum critério alterado — resolve ambiguidade de "valor" em AC-03 (escala 2, arredondamento HALF_UP)
