---
name: prisma-sdd-discipline
description: Lembra a disciplina SDD do Prisma em modo somente leitura — Candidate vs Active, AC≠RN, Decision humana, Native SDD ≠ Self-SDD Active — e aponta docs/ensaios. Use ao planejar ou auditar capability/spec (ex. ensaios PRI-132/174). Nunca promove Active nem escreve log.json.
---

> Skill de produção do Prisma (workflow Cursor); não é runtime do produto; não substitui gates/scripts.

# prisma-sdd-discipline

Guia **somente leitura**. Navega e lembra disciplina; **não** muta spec, Active, writers ou H4.

## Termos

| Termo | Significado operacional |
| --- | --- |
| **Candidate** | Material de ensaio/planejamento; não é regra vigente. |
| **Active** | Registro/regra promovida por decisão humana + mecanismos oficiais — **fora** desta skill. |
| **AC** | Critério de aceite da *change* (ticket/spec); IDs locais (`AC-01` não é global entre tickets). |
| **RN** | Regra permanente da *capability*; não se confunde com AC nem com código/UI. |
| **Decision** | Aprovação humana (Human Review / Decision Center quando existir); UNKNOWN permanece UNKNOWN. |
| **Native SDD** | Disciplina/plataforma Prisma (docs, ensaios, contratos). |
| **Self-SDD Active** | Estado Active do *consumidor* — distinto; não ativar daqui. |
| **H4** | Writer / RRC-SDD / validação sem janela — **não** cumprida por skill. |

## O que pode

- Lembrar Candidate ≠ Active; código/UI ≠ RN aprovado automático.
- Guiar mapeamento mental AC (change) → RN (capability) com rótulos **UNKNOWN** explícitos onde faltar fonte.
- Apontar `docs/spec-guide.md`, `docs/spec-versioning.md`, templates `templates/spec*.md`, e ensaios/docs Linear (ex. PRI-132, PRI-174) **sem** copiar regra de negócio do consumidor para o Linear.
- Entregar checklist + UNKNOWNs + **próxima pergunta humana**.
- Citar que RRC-F31-001/002 continuam NOT APPLIED até decisão governada.

## O que é proibido

- `sdd-create` / `sdd-update` (ou equivalente) via skill.
- Escrever `log.json` (ou promover catalog/Active).
- Fechar H4, reabrir Freeze, aplicar RRC, ou tratar skill como Approval Gate.
- Deduplicar `AC-01` entre changes distintas; publicar lista AC↔RN de negócio do consumidor no Linear sem autorização.
- Rodar `state-writer` / invalidação / SPEC_CHANGE sem o fluxo humano + scripts.
- Transformar ausência de prova em RN ou Active.

## Ponteiros

- Spec (o quê): `docs/spec-guide.md` — validador: `node "$PRISMA_ROOT/scripts/lib/spec-validator.js" …`
- Versionamento / fingerprints: `docs/spec-versioning.md`
- Governança sempre-on: `AGENTS.md` (itens 1–9)
- Ciclo oficial: `.claude/commands/` (plan…commit) — esta skill **não** os substitui

## Saída típica

1. Checklist Candidate / AC↔RN / Decision com UNKNOWNs nomeados.
2. Uma pergunta objetiva para o humano.
3. Explicitar: nada foi promovido a Active; H4 inalterada.
