# Fluxo de desenvolvimento do Prisma

Diagrama do fluxo descrito no `CLAUDE.md` ("Fluxo de desenvolvimento"). As regras
ficam lá e nas skills `.claude/skills/pri-*`; se este desenho divergir delas, valem
as skills.

```mermaid
flowchart TD
    I["Issue PRI-NNN no Linear<br/>com rótulo Processo"] --> S["/pri-start<br/>lê a issue, a fila In Review e a branch<br/>grava .prisma/level e context.json"]
    S --> N{Nível}

    N -->|Leve| B
    N -->|Médio| Q{Precisa de SPEC?}
    Q -->|sim| SM["/pri-spec<br/>SPEC ≤ 1 página na pasta da fatia"]
    Q -->|não| PM
    SM --> PM["/pri-plan<br/>plan.md + todo.md"]
    PM --> R2

    N -->|Alto| SA["/pri-spec<br/>SPEC de 1–2 páginas"]
    SA --> R1{{"Richard aprova a SPEC"}}
    R1 --> PA["/pri-plan"]
    PA --> R2{{"Richard aprova o plano<br/>(Médio e Alto, D-FLX-01)"}}
    R2 -->|"/clear"| B

    B["/pri-build<br/>um subagente novo por tarefa, em sequência<br/>(sonnet no Leve, opus no Médio e Alto):<br/>RED → GREEN → test:changed → commit (Refs PRI-NNN)"]
    B --> C["/pri-check<br/>código: npm test + npm run check<br/>testes novos falham na main<br/>revisor em contexto limpo (Alto: dois)"]
    C --> V{Veredito}
    V -->|FAIL| FX["corrige; o mesmo revisor confere<br/>e os testes rodam no SHA novo"]
    FX -->|"sem nova rodada (regra 6)"| EV
    V -->|PASS| EV[("check.json + review.md<br/>prisma-evidence/issue/sha")]

    EV --> NA{Alto?}
    NA -->|sim| AP["/pri-autorizo (Pedido)<br/>go/no-go, Rollback e Readback<br/>em pedido.md"] --> G
    NA -->|não| G{{"hook: gh pr create só com<br/>check.json PASS no HEAD"}}
    G --> PR["/pri-pr<br/>PR draft, ou pronto no Leve elegível<br/>+ processo:nível<br/>Evidência com o link da CI"]
    PR --> CI{{"CI: Tests + processo-check<br/>Alto também exige Rollback,<br/>Readback e SPEC citada"}}

    CI --> NB{Nível}
    NB -->|Leve / Médio| M{{"Richard mescla = aceite → Done"}}
    NB -->|Alto| AZ{{"merge e AUTORIZO do Richard,<br/>depois o bump"}}
    AZ --> RB["/pri-autorizo PRI-NNN readback"]
    RB -->|PASS| AC{{"Aceite do Richard → Done"}}
    RB -->|FAIL| BL["comentário de bloqueio<br/>rollback só com AUTORIZO,<br/>salvo se o pedido já o incluía"]
```

Os hexágonos são portões: decisão do Richard, hook ou CI. O hook só age numa sessão
de dev (com `.prisma/level`); a barreira real é a CI. No Médio e no Alto,
o plano para para aprovação antes do código; no Alto, a SPEC também. O Leve não para
até o PR. No build, cada tarefa roda num subagente novo, em contexto limpo.
