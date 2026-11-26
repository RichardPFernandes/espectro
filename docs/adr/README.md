# Decisões de arquitetura (ADR)

Um ADR registra uma decisão de arquitetura **já tomada**: o que ficou decidido, por quê e o que muda por causa disso. Ele não propõe nada. A proposta mora na SPEC (Alto) ou na Mesa de Decisões; quando o Richard a aprova e ela muda a arquitetura, vira ADR.

## Onde mora cada coisa

| O quê | Onde | Vida |
| -- | -- | -- |
| SPEC da fatia | `tasks/<pasta>/SPEC.md` | Até o merge; depois vai para `docs/historico/` |
| Spec viva | `docs/capacidades/<id>.md` | Descreve o que a capacidade faz hoje; muda junto com o código |
| ADR | `docs/adr/NNNN-<nome>.md` | Permanente; só muda de status |
| Decisão de roadmap | `roadmap/DECISOES.md` | Ordem, escopo e premissas das fases |

É decisão de arquitetura o que muda um contrato, um dono, uma fronteira entre plataforma e consumidor, ou o processo que todas as fatias seguem. Escolha de implementação dentro de uma fatia fica na SPEC.

## Regras

- Modelo em [`modelo.md`](modelo.md): front-matter, Fonte, Contexto, Decisão e Consequências. Uma página.
- O front-matter traz `id` (`ADR-NNNN`, igual ao número do arquivo), `status` (MADR: proposta, aceita, rejeitada, obsoleta, substituída), `data`, `capacidades` e, quando houver, `substitui` e `substituida_por`, sempre por ID. A seção "Ligações" no fim da página é gerada: rode `node scripts/knowledge-links.js --write` e inclua o resultado no commit. O `processo-check` reprova ID inexistente, lado divergente e seção defasada (ADR 0008).
- **Fonte é obrigatória** e aponta onde a decisão foi tomada: `roadmap/DECISOES.md`, Mesa de Decisões (ID `D-...`), SPEC arquivada ou PR. Sem fonte, não é ADR.
- Número não muda nem é reaproveitado. Decisão trocada ganha ADR novo, com `substitui`, e o antigo passa a `status: substituída`, com `substituida_por`.
- Quem toma a decisão numa fatia abre o ADR no mesmo PR (o `/pri-pr` pergunta); a Evidência traz a linha "ADR: número ou nenhum".
- Não há tipo RFC. SPEC Alto e proposta da Mesa já cumprem esse papel.

## Índice

| ADR | Decisão | Status |
| -- | -- | -- |
| [0001](0001-checkout-com-ponto-de-retorno.md) | O consumidor roda de checkout, com ponto de retorno; não volta ao pin | Aceita |
| [0002](0002-monolito-modular-por-capacidade.md) | Monólito modular por capacidade, sem Arquitetura Limpa nem DDD tático | Aceita |
| [0003](0003-merge-automatico-do-leve.md) | O bot mescla o PR Leve elegível; agente nunca mescla | Aceita |
| [0004](0004-repo-publico-open-source.md) | O repo é público de propósito, porque o Espectro vai ser open source | Aceita |
| [0005](0005-so-claude-sem-codex.md) | Só Claude; a revisão independente é outro agente Claude em contexto limpo | Aceita |
| [0006](0006-acordo-v2-niveis-pelo-efeito.md) | Três níveis de processo pelo efeito, com a evidência no PR | Aceita |
| [0007](0007-spec-viva-por-capacidade.md) | Spec viva de uma página por capacidade, atualizada pelo delta no PR | Aceita |
| [0008](0008-adrs-em-docs-adr-com-ligacoes.md) | Os ADRs moram em `docs/adr/`, ligados às capacidades por ID no front-matter | Aceita |
