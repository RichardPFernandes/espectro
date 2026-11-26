---
id: ADR-0004
status: aceita
data: 2026-11-17
capacidades: []
---

# ADR 0004: O repo é público de propósito, porque o Espectro vai ser open source

**Fonte:** `roadmap/DECISOES.md` D8 (17/11/2026); Mesa `D-PRI-401-01` (resposta de 18/11: aprovada a recomendação sobre histórico, texto dos PRs e nomes do consumidor)

## Contexto

Em 16/11 se constatou que o repo no GitHub estava público, e a premissa do roadmap era fechá-lo. O Richard corrigiu: o repo é público de propósito.

## Decisão

O repo fica público. Dado do consumidor (dados, credenciais, histórico, knowledge) não deve entrar nele; o que já entrou recebe destino pela varredura.

## Consequências

- A F1.9 (PRI-401) varre a `main`, os commits alcançáveis e o texto dos PRs, e dá destino a cada achado. O relatório traz contagens e caminhos, nunca o dado exposto.
- O histórico do Git não é reescrito sem decisão do Richard; no passe de 18/11 ele aceitou os achados que ficaram nele.
- Neutralizar nomes do consumidor no código vem antes de divulgar o open source, em fatia própria.
