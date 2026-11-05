# PRI-181 — confirmação P1 ainda falta

## O quê

Há um pacote técnico denso de decisões P1 (itens P-R3-01, DB-16b, RR-01…06) com recomendação todas **A**, e um “aprovo” solto no Project. Esse “aprovo” genérico **não** vale como decisão P1 desta issue: falta confirmação explícita com versão, hash e letra por item. Isto **não** aplica reconciliação, **não** libera C1+ (próxima fase de implementação após P1), **não** fecha a issue e **não** declara P1 APPLIED.

## Por quê

Sem P1 explícito, a cadeia anti-recusa não avança para registro APPLIED/NOT nem para liberação de Implementation / C1. Tratar o “aprovo” genérico como confirmação seria inventar Approval. Em paralelo (sem desbloquear C1) ainda cabem gate Claude + checagem de SHA no host e trabalho nas issues 184 / 207 / 86 / 225 — nenhum desses substitui P1 da 181.

Glossário rápido na 1ª ocorrência: **P1** = pacote de decisão humana desta issue; **DB-16b** = item de decisão humana na PRI-181; **RRC** (Architecture Change Candidate) = candidato de mudança estrutural — **não** aplicar neste passo.

## Quando

Ordem: P0 (host) → **P1 (você, agora)** → registrar APPLIED/NOT → inventário → **só então** você libera Implementation / C1. Confirmação P1 é o bloqueio atual. Review Claude + SHA no Mac (opção A do RR-06) pode andar **em paralelo**, sem desbloquear C1.

## Próximos passos

1. **Não** aplicar reconciliação / **não** liberar C1+ / **não** fechar a issue.
2. Confirmar o pacote recomendado (todas **A**) com comentário na PRI-181 — ou editar letras antes.
3. Em paralelo (sem desbloquear C1): revisão Claude + SHA no Mac, se for seguir a opção A do item RR-06.

### Reply mínimo (se preferir Project)

```text
CONFIRMO P1 PRI-181: P-R3-01=A DB-16b=A RR-04=A RR-05=A RR-02=A RR-03=A RR-01=A RR-06=A
r4 SHA 5d109817364c06ef657cb897e7101aadec66a8a291a542206ca9dbc2ea8ee78d
Não aplica RRC / não autoriza C1+ neste passo.
```

## Decisões (só se bloquearem o próximo passo)

- **Confirma P1** com o pacote recomendado todas A (ver draft no doc técnico §F)? *(bloqueia registro APPLIED/NOT e C1+)*
- Se **não**: quer listar deltas (ID = letra) antes de postar?

---

Técnico: [`pri-181-next-actions.md`](./pri-181-next-actions.md) · Decisões: [`pri-181-human-decisions.md`](./pri-181-human-decisions.md) · Issue: [PRI-181](https://linear.app/prisma-app/issue/PRI-181)
