# SPEC: piloto do plugin `prova` sobre o backfill de horas multi-run (PR 68)

> **Status:** rascunho de 21/11/2026, escrito depois do código, a partir do PR [#68](https://github.com/RichardPFernandes/espectro/pull/68) (`cursor/fix-horas-multirun-order-d016`, commit `f28020f`). Ainda não aprovada pelo Richard. Sem issue PRI nem nível de processo: a definir. Serve ao piloto do plugin `prova` (tarefa 7 do plano dele): os ACs abaixo usam o formato do plugin, `AC-<n> [nível]`.

## Contexto

O backfill de horas do Redmine (`scripts/backfill-redmine-hours.js`, `scripts/lib/redmine-hours-sync.js`) cria uma entry por Run. Sem `--fill-even-if-spent`, só a primeira entry do ticket entra: as outras são puladas com `issue_already_has_spent`. A ordem dos candidatos vinha do `readdir`, então uma Run de 0,5 h podia ganhar de um ciclo maior do mesmo ticket.

Na remediação apareceu um segundo problema: Runs com wall-clock ocioso geram entries de dezenas de horas, e não havia como deixá-las de fora.

## Objetivo

Em ticket com várias Runs, a entry gravada é a da Run com mais horas. Quem roda o backfill pode dar um teto de horas por entry, e a entry acima do teto é pulada, sem arredondar.

## Critérios de Aceite

- AC-1 [unit]: `orderCandidatesForSync` devolve os candidatos `ok: true` em ordem decrescente de `hours`, com o empate na ordem de entrada, e deixa cada candidato `ok: false` na posição em que entrou.
- AC-2 [integration]: `runBackfill` sem `fillEvenIfSpent`, com duas Runs do mesmo ticket (1 h gravada antes, 2 h depois), cria a entry da Run de 2 h e pula a outra com `issue_already_has_spent`. O dry-run dá as mesmas ações e os mesmos totais do apply (`would_create` no lugar de `created`), o apply faz um POST e o dry-run não faz nenhum.
- AC-3 [integration]: `syncCandidateHours` com `maxEntryHours: 8` e um candidato de 27,5 h devolve `action: 'skip'` com `reason: 'exceeds_max_entry_hours'`, mantém `hours` em 27,5 e não faz POST.
- AC-4 [unit]: `--max-entry-hours` com valor que não é número maior que zero faz o `parseArgs` do `backfill-redmine-hours.js` lançar `--max-entry-hours exige número > 0`. Sem a opção, `maxEntryHours` é `null` e nenhuma entry é pulada pelo teto.

## Comandos e estrutura

- Foco: `node --test scripts/lib/redmine-hours-sync.test.js`
- Receita oficial: `npm test` na raiz. Conferência do elo AC ↔ teste: `/prova:check` (adaptador em `prova.config.json`).
- Arquivos: `scripts/lib/redmine-hours-sync.js` (`orderCandidatesForSync`, `maxEntryHours` em `syncCandidateHours` e `runBackfill`), `scripts/backfill-redmine-hours.js` (opção e ajuda), `scripts/lib/redmine-hours-sync.test.js`.

## Boundaries

- **Sempre:** cada teste desta fatia cita o ID do AC que prova, no nome do teste.
- **Perguntar antes:** mudar o adaptador `prova.config.json`; trocar o nível de um AC.
- **Nunca:** mudar o marcador `[prisma-hours:task]` ou o caminho ao vivo do `/commit`; igualar horas entre Runs do mesmo ticket; rodar o backfill com `--apply` contra o Redmine real por causa deste piloto.
