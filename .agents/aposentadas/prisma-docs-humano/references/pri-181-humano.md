# PRI-181 — falta confirmação explícita (o “aprovo” solto não conta)

## O quê

Há um pacote de decisões humanas nesta issue (itens com letras recomendadas todas **A**) e um “aprovo” genérico no Project. Esse “aprovo” **não** vale: falta confirmação com versão, hash e letra por item.

Isto **não** aplica mudança de arquitetura, **não** libera a próxima fase de implementação, **não** fecha a issue e **não** declara o pacote como APPLIED.

## Por quê

**Qualidade:** tratar “aprovo” solto como decisão real inventaria Approval — autoridade falsa.  
**Custo:** sem confirmação explícita, a cadeia anti-recusa não registra o pacote nem libera implementação; o time continua em paralelo (184, 207, 86, 225) **sem** destravar o passo caro.  
**Dia a dia:** board e código do produto **não** mudam neste passo; o que muda é só a clareza de “está confirmado ou não”.

Glossário só do necessário: **P1** = este pacote de decisão humana; **C1+** = fase de implementação que só começa depois do P1; **RRC** = candidato a mudança de arquitetura — **não** aplicar aqui.

## Quando

Ordem prática: checagens de host → **sua confirmação agora** → registrar APPLIED/NOT → inventário → **só então** liberar implementação. Review Claude + SHA no Mac pode andar **em paralelo**, sem liberar implementação.

## Próximos passos

1. **Não** aplicar reconciliação / **não** liberar implementação / **não** fechar a issue.
2. Confirmar o pacote recomendado (todas **A**) com comentário na PRI-181 — ou editar letras antes.
3. Em paralelo (sem liberar implementação): revisão Claude + SHA no Mac, se for a opção A do item RR-06.

### Reply mínimo (se preferir Project)

```text
CONFIRMO P1 PRI-181: P-R3-01=A DB-16b=A RR-04=A RR-05=A RR-02=A RR-03=A RR-01=A RR-06=A
r4 SHA 5d109817364c06ef657cb897e7101aadec66a8a291a542206ca9dbc2ea8ee78d
Não aplica RRC / não autoriza C1+ neste passo.
```

## Decisões (só se bloquearem o próximo passo)

- **Confirma o pacote** com todas A (ver draft no doc técnico §F)? *(bloqueia registro e a fase de implementação)*
- Se **não**: quer listar deltas (ID = letra) antes de postar?

---

Técnico: [`pri-181-next-actions.md`](./pri-181-next-actions.md) · Decisões: [`pri-181-human-decisions.md`](./pri-181-human-decisions.md) · Issue: [PRI-181](https://linear.app/prisma-app/issue/PRI-181)
