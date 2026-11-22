---
id: ADR-0001
status: aceita
data: 2026-11-17
capacidades: [ciclo-da-run, ferramentas]
---

# ADR 0001: O consumidor roda de checkout, com ponto de retorno; não volta ao pin

**Fonte:** `roadmap/DECISOES.md` D3 (17/11/2026); Mesa `D-RMP-01`, resposta 3; Mesa `D-PRI-379-01` (SPEC da F1.2)

## Contexto

O consumidor sobe o Espectro de um checkout deste repo. A alternativa era voltar a fixar uma versão (pin, PRI-371). O checkout vivo não tinha como voltar ao último estado verde, nem recusava subir sujo ou fora da `main`.

## Decisão

O modo checkout continua. A volta é por um ponto de retorno: uma tag anotada "último verde", marcada só depois de uma checagem de saúde, e um comando que leva o checkout a ela. A PRI-371 não segue.

## Consequências

- F1.2 (PRI-379) constrói o comando `return-point`, a tag e o guard que recusa subir com árvore suja ou fora da `main`.
- O guard fica atrás da flag `PRISMA_CHECKOUT_GUARD`, desligada. Ligá-la, o ensaio no checkout vivo e a primeira tag exigem AUTORIZO do Richard.
- Nada reescreve histórico: a volta deixa o HEAD destacado na tag.

<!-- ligacoes:inicio -->
## Ligações

- Capacidades: [ciclo-da-run](../capacidades/ciclo-da-run.md)
- Capacidades: [ferramentas](../capacidades/ferramentas.md)
<!-- ligacoes:fim -->
