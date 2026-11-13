# Evidência: prova do U10-a na CLI 2.1.323 (PRI-311, 2026-11-13)

Adendo à tarefa 0 (`SPEC-s5.2.md`, seção "Tarefa 0"; S5.2a `u10-probe-evidence.json`, CLI 2.1.319).
Resultado: **prova obtida** na 2.1.323. Isto **não** é "gate cumprido": cumprir ou dispensar o
gate do RC-1 segue sendo ato do Richard (SPEC.md, Portas, item 1).

## Por que

A CLI instalada passou de 2.1.319 para 2.1.323. `subagentMechanism` só aceita versões com prova
própria, então em Run real o mecanismo ficaria `UNVERIFIED` → `UNENFORCED`
(`CLI_VERSION_NOT_PROVEN`).

## Autorização e protocolo

- **«Sim» do Richard:** 2026-11-13, escolha "Nova prova na 2.1.323" na sessão da PRI-311, depois
  de proposta que dizia "até 6 chamadas ao provider, login seu num perfil isolado". Rodada
  distinta da Q10 (a) de 2026-11-09.
- **Chamadas:** 3 de 6 (controle + `--agents` × 2). Nenhuma repetição (`repeat_authorized: null`).
- **U10-b (variável de ambiente) não executado, de propósito:** deu `PROOF_NOT_OBTAINED` na
  2.1.319, não cobre papel a papel e o código não o usa.
- **Perfil isolado:** `~/u10-probe-323/config`, fora do repositório; login feito pelo Richard; o
  agente não leu nem registrou credencial. O perfil (com o ledger do teto) foi **apagado** depois
  das 3 chamadas; o teto e a não repetição ficam auditáveis por este arquivo e pelo JSON.
- Plugin `jev-model-router` provado `NOT_LOADED` (settings `49af361031bd…`), sem MCP, repositório
  sintético, modelos: principal opus, frontmatter haiku, declarado sonnet. Evidência só agregada.

## Resultado (`u10-probe-evidence-2.1.323.json`)

| Ordem (`at`, UTC) | Candidato | Execução | Resultado | Observado nos dois papéis |
| -- | -- | -- | -- | -- |
| 13:10:44 | controle | 1 | `CONTROL_DETECTS_FRONTMATTER` | haiku (= frontmatter) |
| 13:11:04 | `--agents` | 1 | `PROOF_OBTAINED` | sonnet (= declarado) |
| 13:11:21 | `--agents` | 2 | `PROOF_OBTAINED` | sonnet (= declarado) |

## Código

- `model-routing.js`: `SUBAGENT_MECHANISM_PROOF.proof_refs` (versão → evidência própria);
  `cli_versions` derivado dele. VERIFIED cita a prova da própria versão.
- **Mudança de valor persistido:** em decisões novas, `subagent_mechanism.proof_ref` é `null`
  quando `UNVERIFIED` (antes citava a prova da 2.1.319). Registros já gravados não são migrados
  nem reinterpretados; leitores devem aceitar os dois formatos.
- Teste `model-routing-decomposed.test.js` (AC-27): cada `proof_ref` precisa ter, na própria
  versão, controle que vê o frontmatter e exatamente `--agents` 1 e 2, em ordem, ambos
  `PROOF_OBTAINED`, com observado = declarado.

## Limites (inalterados)

Só o modelo foi verificado; esforço do subagente (U1) e subagentes embutidos da CLI seguem não
verificados. Flag `decomposition = on` reservada. RC-1 a RC-6 e RRC-F31-001/002 NOT APPLIED.
