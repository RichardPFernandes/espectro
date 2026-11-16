# Reconciliação com o Linear

> Leitura de 15/11/2026, só títulos, estado e rótulos (comentários não lidos). 171 issues
> abertas: 11 em andamento ou revisão, 62 Ready, 98 Backlog. Nada foi alterado no Linear.
> O vínculo fatia ↔ issue está na coluna "Issue no Linear" de cada `FASE.md`.

## Conflitos com o roadmap

| O que o roadmap dizia | O que o Linear mostra | Decisão necessária | Situação no mapa |
| -- | -- | -- | -- |
| Nenhuma flag liga antes do fim da Fase 1 | PRI-354 tem AUTORIZO de 15/11 para ligar o esforço por fase no launcher de um piloto no próprio Espectro, depois do baseline da PRI-341 | Os dois pilotos esperam a Fase 1, ou seguem em paralelo por rodarem num launcher próprio, fora do consumidor corporativo | Decidido em 16/11: seguem em paralelo (D11) |
| F2.3 com teto de 15 runs | PRI-354 define 10 pares de runs | Vale a issue; ajustar a F2.3 | Refletido na F2.3 |
| F2.5 removia o writer de Self-SDD | PRI-349, PRI-297, PRI-265, PRI-319 e PRI-264 estão Ready no cycle | Remover e cancelar as cinco, ou manter e tirar da F2.5 (D5) | Refletido: o writer fica; as issues saem do cycle até a Fase 2 fechar (D5) |
| Classificador Jev congelado | PRI-321 e PRI-291 Ready no cycle; PRI-358 e PRI-90 abertas | Cancelar ou estacionar (D5) | Aguardando D5 |
| Verificação de UI desligada até a F6.8 | PRI-360 e PRI-361 em andamento; PRI-370 e PRI-362 no Backlog | Terminar as duas em andamento e parar, ou congelar já | Aguardando D5 |
| D4: ninguém externo em seis meses | A PRI-354 já trata o Espectro como consumidor piloto | D4 passa a "o próprio repo do Espectro"; a F3.2 pode encolher | Refletido em D4 e na F3.2 |

## Em andamento e fora do roadmap

PRI-373 (exportar para Obsidian), PRI-363 e filhas PRI-364, 365, 366 (investigação dos
UNKNOWN), PRI-369 (design de UNKNOWN). Terminam ou saem na triagem do cycle.

## Issues que o roadmap não tinha e deveria considerar

| Issue | Por quê | Onde entra |
| -- | -- | -- |
| PRI-179 (Alto, Ready) | Bug: o push dos repos irmãos é pulado e reportado como sucesso | F1.6, na frente de contenção da Fase 1 |
| PRI-372 (Médio, Backlog) | Testes em worktree gravam no log do checkout vivo | Junto da F1.2 |
| PRI-335 (Alto, Ready) | Validar o `state.json` da run decomposta antes de ligar a flag | Pré-requisito da F2.2 |
| PRI-359 (Leve, Backlog) | Falhas anteriores na suíte, incluindo o depcruise | Antes da F2.4 |
| PRI-374 (Médio, Ready) | Bug no esforço de `subagent_roles` | Antes da F2.2 |

## Vínculos já conhecidos das fases seguintes

F3.6 ↔ PRI-151 · F4.2 ↔ PRI-352 e filhas · F4.4 ↔ PRI-253, PRI-173, PRI-129 ·
F5.1 ↔ PRI-318 · F5.4 ↔ PRI-81, PRI-76 · F6.8 ↔ PRI-295 · F6.10 ↔ PRI-275 a 280, PRI-86 ·
F6.11 ↔ PRI-96, PRI-133 · F6.12 ↔ PRI-299, PRI-300 e filhas, PRI-344, PRI-346.

## Sem lugar no roadmap (estacionar)

Migração TypeScript (21 issues), Decision Center em projetos próprios (cerca de 15),
"Design · planejar implementação" (11), avaliações de ferramentas externas, Learning Hub e
onboarding, Self-SDD em consumidores (PRI-350 e filhas).
