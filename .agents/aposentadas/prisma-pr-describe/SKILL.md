---
name: prisma-pr-describe
description: Redige body de PR autoexplicativo no Prisma (o quê / por quê / o que mudou / o que não muda / como verificar / o que o humano decide). Use ao abrir ou atualizar PR no fluxo Cursor↔GitHub.
---

> Skill de produção do Prisma (workflow Cursor); não é runtime do produto; não substitui gates/scripts.

**Faixa de modelo:** leve — sem Opus. Ver `.agents/reference/skill-model-map.md`.

# prisma-pr-describe

Redige descrição de PR legível **sem** abrir o diff inteiro. Acionar sob demanda (§1.1 esteira de produção); não é nó do ciclo despachado.

## Estrutura fixa: `.github/pull_request_template.md` (Acordo v2)

1. **Nível** e **Issue** (`Refs PRI-NNN`, nunca "Fixes").
2. **O que muda** — 2–3 linhas, do ponto de vista de quem usa, alinhadas ao **diff real**.
3. **Como testar** — comandos ou passos e o resultado esperado.
4. **Evidência** — tabela AC / Resultado / Prova. É a única evidência: não há `evidence-*.md`. O check `processo-check` falha se a seção estiver vazia.
5. **Riscos** — ou "nenhum relevante".
6. **Fica ligado?** — sim, onde; ou não, atrás de qual flag e quando ela liga.

Rótulo do PR: exatamente um entre `processo:leve`, `processo:medio`, `processo:alto`. Título sem `[HIGH-RISK]`; o nível vai no rótulo. Título: só alterar se o existente for ilegível.

## Regras

- Basear-se em `git diff` / arquivos da PR + issue citada — **sem inventar** AC, Decision ou escopo além do diff.
- Não declarar gate PASS, Done Linear ou merge implícito pelo body.
- Preferência do Project: PR autoexplicativo em português claro.
- PR sempre em draft; skill não faz merge.

## Fora do escopo

- Substituir review independente, `/verify` ou Approval Gate.
- Reescrecer histórico de commits ou inventar evidência.
