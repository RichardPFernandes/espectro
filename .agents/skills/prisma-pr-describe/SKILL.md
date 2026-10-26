---
name: prisma-pr-describe
description: Redige body de PR autoexplicativo no Prisma (o quê / por quê / o que mudou / o que não muda / como verificar / o que o humano decide). Use ao abrir ou atualizar PR no fluxo Cursor↔GitHub.
---

> Skill de produção do Prisma (workflow Cursor); não é runtime do produto; não substitui gates/scripts.

# prisma-pr-describe

Redige descrição de PR legível **sem** abrir o diff inteiro. Acionar sob demanda (§1.1 esteira de produção); não é nó do ciclo despachado.

## Estrutura fixa (português)

1. **O que faz** — uma frase (ou tabela curta se forem vários artefatos).
2. **Por quê** — por que importa (issue/autorização/handoff; sem inventar).
3. **O que mudou** — paths/comportamento alinhados ao **diff real**.
4. **O que NÃO muda** — gates, Freeze, RRC, Active, H4, runtime, consumidores, etc., quando pertinente.
5. **Como verificar** — passos concretos (comandos, arquivos a olhar).
6. **O que o humano decide** — merge, ajuste, follow-up; **não** pedir aprovação automática.

Título: só alterar se o existente for ilegível.

## Regras

- Basear-se em `git diff` / arquivos da PR + issue/handoff citados — **sem inventar** AC, Decision ou escopo além do diff.
- Não declarar gate PASS, Done Linear ou merge implícito pelo body.
- Preferência do Project: PR autoexplicativo em português claro.
- Draft OK quando a fatia pedir; skill não faz merge.

## Fora do escopo

- Substituir review independente, `/verify` ou Approval Gate.
- Reescrecer histórico de commits ou inventar evidência.
