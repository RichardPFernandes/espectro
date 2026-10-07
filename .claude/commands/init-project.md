---
description: Roda uma vez por projeto novo — entrevista o usuário (ou lê o código existente) e monta memory/project.yaml, memory/spec/00-overview.md e memory/spec/index.yaml iniciais.
---
> Consumo externo da candidata PRI-60: `PRISMA_ROOT` aponta ao checkout fixado da
> plataforma; cwd/`REPO_PATH` e `memory/` pertencem ao consumidor/worktree.
> Referências a `scripts/`, `templates/`, `.graph/schemas/` e a este template são
> assets da plataforma, resolvidos por `PRISMA_ROOT`; configuração, spec e registros
> históricos continuam no consumidor. Não copiar/reatar estado para corrigir paths.
> Regras, toolchain e repositórios relacionados vêm de `memory/project.yaml` e da
> configuração explícita do consumidor. Exemplos históricos não definem defaults.


Você está inicializando a memória deste projeto pela primeira vez.

## Passos
1. Se já existir código no repositório, leia a estrutura antes de perguntar — infira
   stack, domínios e módulos existentes em vez de perguntar tudo do zero.
2. Pergunte (só o que não deu pra inferir): nome do projeto, problema que resolve,
   stack (frontend/backend/banco/hospedagem), regras invioláveis de
   negócio/segurança, e o mapeamento de qual subagente cobre qual tipo de mudança.
3. Preencha `memory/project.yaml` com essas respostas.
4. Crie `memory/spec/00-overview.md` com a visão geral em prosa.
5. Crie entradas em `memory/spec/index.yaml`, uma por domínio/módulo identificado,
   com status real (`planejado` / `em_construcao` / `pronto`). É a única fonte de
   status por módulo — não crie arquivo de status separado (ver
   `memory/decisions/2026-09-29-remocao-status-yaml.md`).
6. Faça o primeiro commit: "chore: inicializa memória do projeto via /init-project".

Depois disso, todo trabalho no projeto passa pelo ciclo normal: `/plan` →
`/implement` → `/review` → `/test` → `/verify` → `/commit`.
