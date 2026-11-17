# PRI-207 — desenho operacional aprovado; sem código ainda

## O quê

O pacote de desenho operacional (contexto mínimo no laço review→implement + escalonamento em sombra, sem subir tier sozinho) **já está aprovado**. A dependência Linear que bloqueava foi limpa.

Isto **ainda sem** autorização de runtime: **não** autoriza código, watcher, schemas, limiares numéricos, tentativa efetiva de escalonamento, nem ligação com o retry de QA (PRI-184) — domínio distinto.

## Por quê

**Qualidade:** misturar desenho já aprovado com build nesta mesma issue apagaria a linha entre “combinamos o HOW” e “podemos rodar no produto”.  
**Custo:** implementar envelope / sombra / Attempt aqui gastaria ciclos sem Promotion Gate (autorização humana de promover implementação).  
**Dia a dia:** nada muda no produto até existir **issue de implementação separada** + autorização explícita nessa issue.

## Quando

Agora: tratar o desenho como fechado e **não** implementar nesta issue. Build só **quando** houver issue separada + Promotion Gate autorizado. Contagem “N antes de would_escalate” permanece UNKNOWN até evidência.

## Próximos passos

1. Tratar o desenho como fechado (decisões D-207-1…6 = A).
2. **Não** implementar envelope / sombra / Attempt sem issue separada + Promotion Gate.
3. Quando quiser build: abrir issue de implementação separada e autorizar Promotion Gate nessa issue *(ainda não)*.

## Decisões (só se bloquearem o próximo passo)

- Abrir issue de implementação separada e autorizar Promotion Gate? *(só quando quiser build — omitível se o próximo passo for só manter o desenho fechado)*

---

Ask original: [`pri-207-human-ask.md`](./pri-207-human-ask.md) · Proposta: [`pri-207-proposal.md`](./pri-207-proposal.md) · Issue: [PRI-207](https://linear.app/prisma-app/issue/PRI-207)
