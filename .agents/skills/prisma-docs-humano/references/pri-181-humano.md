# PRI-181 — o que fazer agora

**Veredito:** o “aprovo” solto no Project **não** vale como decisão P1 desta issue — falta confirmação explícita com versão, hash e letra por item.

## Agora

1. **Não** aplicar reconciliação / **não** liberar C1+ / **não** fechar a issue.
2. Confirmar o pacote recomendado (todas **A**) com um comentário na PRI-181 — ou editar letras antes.
3. Em paralelo (sem desbloquear C1): revisão Claude + SHA no Mac, se for seguir a opção A do item RR-06.

## Decisões (sim / não)

- **Confirma P1** com o pacote recomendado todas A (ver draft no doc técnico §F)?
- Se **não**: quer listar deltas (ID = letra) antes de postar?
- Aceita que “aprovo” genérico **não** cobre esta decisão?

## Reply mínimo (se preferir Project)

```text
CONFIRMO P1 PRI-181: P-R3-01=A DB-16b=A RR-04=A RR-05=A RR-02=A RR-03=A RR-01=A RR-06=A
r4 SHA 5d109817364c06ef657cb897e7101aadec66a8a291a542206ca9dbc2ea8ee78d
Não aplica RRC / não autoriza C1+ neste passo.
```

## O que já pode andar sem P1

- Gate Claude + checagem de SHA no host (não decide P1).
- Paralelos: 184 / 207 / 86 / 225 — **não** substituem P1 da 181.
- Papelada Candidate / planning.

## Depois da confirmação (ordem)

P0 (host) → **P1 (você)** → registrar APPLIED/NOT → inventário → **só então** você libera Implementation / C1.

---

Técnico: [`pri-181-next-actions.md`](./pri-181-next-actions.md) · Decisões: [`pri-181-human-decisions.md`](./pri-181-human-decisions.md) · Issue: [PRI-181](https://linear.app/prisma-app/issue/PRI-181)
