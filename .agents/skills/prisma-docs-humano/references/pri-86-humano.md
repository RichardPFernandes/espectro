# PRI-86 — ciclo 1 documental aceito

## O quê

Ciclo 1 aceito: mantém o fluxo atual de recusa/QA; **não** adota aprendizado automático agora; Fatia C fica para um 2º ciclo. Ficou decidido no ciclo 1: fluxo operacional **manter**; IMPROVE automático (prompt, skill, policy, routing) **adiar**; Rejection→Regression / perguntas 198 / preventivo **adiar** (2º ciclo). Sem piloto, sem código runtime, sem Promotion Gate neste ciclo. Aceite D **não** é Done automático da issue.

## Por quê

O destino da issue (Done do ciclo 1 vs deixar aberta/Backlog para Fatia C) ainda precisa de escolha humana — o agente **não** muda o status. Autorizar Fatia C ou build de observação agregada (A1) agora, sem outcomes da PRI-181 e sem path/janela/dono, reabriria escopo que o ciclo 1 deliberadamente adiou.

## Quando

Agora: escolher o destino da issue. Q4–Q7 (qualidade / cosmético) são opcionais e não mudam MANTER/ADIAR. Fatia C e A1: **depois** dos outcomes da PRI-181 (e, para A1, com path/janela/dono). Não implementar A1–A7 nem iniciar Fatia C sem HR (Human Request) novo. Não copiar notas QA / corpo Redmine para aprendizado.

## Próximos passos

1. Escolher o destino da issue (Done do ciclo 1 **ou** aberta/Backlog para Fatia C) — o agente não muda o status.
2. Opcional: fechar Q4–Q7 se quiser.
3. Esperar outcomes da PRI-181 antes de autorizar Fatia C ou qualquer piloto.

## Decisões (só se bloquearem o próximo passo)

- **Done agora** (ciclo 1 documental basta) **ou** deixar aberta / Backlog só para Fatia C no 2º ciclo? *(bloqueia o próximo status da issue)*

---

Técnico: [`pri-86-fatia-d.md`](./pri-86-fatia-d.md) · Issue: [PRI-86](https://linear.app/prisma-app/issue/PRI-86)
