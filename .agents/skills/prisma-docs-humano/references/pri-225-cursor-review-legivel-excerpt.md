# PRI-225 — parecer técnico legível (trecho-exemplo)

> Exemplo ouro da skill `prisma-docs-humano`: reescrita do trecho denso de
> `pri-225-cursor-review.md`. Não substitui o original; mostra o padrão
> glossário + “o que foi achado” + “por que importa” **antes** da matriz.

**Data:** 2026-10-29 · Revisado no Cursor (não Claude), conforme pedido do Richard.  
**Isto não é** Approval Gate (aprovação formal de produto), **não** fecha a issue como Done, **não** muda código nem o Roadmap.

Issue: [PRI-225](https://linear.app/prisma-app/issue/PRI-225)

---

## O que foi achado (em português claro)

Uma auditoria anterior (Codex v1) disse que o caminho de **autorização humana** — o fluxo em que uma pessoa aprova ou recusa um efeito externo, por exemplo SQL allowlist / `db-effect` — **não está alinhado** com as regras publicadas de invariantes humanas.

Esta revisão Cursor **relê** código + documento de invariantes e **confirma** esse diagnóstico: há **cinco** pontos em que o comportamento diverge do alvo, **cinco** pontos em que a prova ainda é inconclusiva, e **nenhum** ponto marcado como conforme. Os achados graves (redecidir depois de falha, trocar o pedido sem cercar o efeito antigo, contexto frágil depois da decisão) estão no código da main fixada pela auditoria.

**Integridade do pacote de prova:** parcial. Texto Linear + invariantes + código: ok. A pasta de custódia no Mac (probes = scripts que exercitam o fluxo e gravam hashes) **não** veio nesta rodada — então qualquer claim que dependa só da saída dos probes fica **inconclusivo por reprodução**. Isso **não** apaga os achados lidos no código.

## Por que importa

**Qualidade:** enquanto esses gaps existirem, **não** dá para tratar o Human Gate (porta humana antes do efeito externo) como certificado, **nem** promover a PRI-180 a **writer** (componente que grava estado autoritativo) sob DS-09.  
**Custo:** seguir com build como se a auditoria já estivesse “aprovada” gastaria ciclos em cima de diagnóstico ainda sem aceite.  
**Dia a dia:** aceitar este parecer só reconhece o diagnóstico; **não** autoriza código nem muda o produto. Os achados graves, se aceitos, vão para reconciliação humana (PRI-17) — **fora** desta auditoria.

**Veredito operacional:** pronto para **decisão humana** (aceitar ou pedir REVISE). Em jargão de review: `APPROVE_FOR_HUMAN_DECISION` — ou seja, “pode decidir”; **não** “produto aprovado”.

---

## Glossário usado abaixo (também inline na 1ª ocorrência)

| Sigla / termo | Significado aqui |
| --- | --- |
| PHI | Policy / Human Invariants — invariantes humanas da reconciliação (HI-13, itens 01…10) |
| DS-09 | Decisão de desenho: Decision imutável / uso único; writer único por projeto |
| DIVERGENT | Comportamento do código **diverge** do alvo PHI |
| INCONCLUSIVE | Prova insuficiente nesta rodada (não é “ok” nem “falhou”) |
| COMPLIANT | Alinhado ao alvo |
| F-01…F-05 | Achados numerados da auditoria (falhas/riscos concretos) |
| RRC | Architecture Change Candidate — mudança estrutural só com decisão governada |
| CAS | Compare-and-swap / trava de idempotência por `operation_id` |
| AUTH-id | Identificador de um pedido de autorização |

---

## Matriz PHI-01…10 (só depois da prosa)

Fonte: HI-13 § PHI-01…10 (publicado). Coluna Cursor = este parecer.

| PHI | Codex v1 | Cursor | Em uma frase |
| -- | -- | -- | -- |
| 01 | DIVERGENT | **DIVERGENT** | Depois de falha/incerteza, o mesmo AUTH-id ainda aceita `reject`/`markManual` — a Decision não fica “fechada de verdade”. Achado F-01. |
| 02 | DIVERGENT | **DIVERGENT** | Um pedido novo (supersede) troca a chave do efeito sem cercar a obrigação anterior. Achado F-02. |
| … | … | … | *(demais linhas no doc técnico completo)* |

**Resumo:** 5 DIVERGENT / 5 INCONCLUSIVE / **0 COMPLIANT** — igual à v1.

### DS-09 (writer / Decision imutável)

**DIVERGENT** *como candidato a executor* das operações protegidas SDD — concorda com a v1. O writer físico continua na [PRI-231](https://linear.app/prisma-app/issue/PRI-231). **Não** promover PRI-180 a writer nesta Audit. RRC-F31-001/002 continuam **NOT APPLIED**.

---

Humano (decisões sim/não): ver `pri-225-humano.md` no mesmo diretório de docs do store.
