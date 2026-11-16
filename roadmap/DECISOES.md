# Decisões do Richard

> Nenhuma trava o início: as Fases 1 e 2 são iguais em quase todas as respostas. Enquanto a
> coluna **Decidido** estiver vazia, vale a premissa. Ao decidir, preencha a data e a escolha
> na mesma linha; não crie outro documento.

| ID | Pergunta | Premissa assumida | Alternativa | O que muda na ordem | Decidido |
| -- | -- | -- | -- | -- | -- |
| D1 | O que é "custo"? | Em aberto. A linha de base grava USD imputado, tokens e tempo. Da Fase 3 em diante: assinatura | Dinheiro (API paga) ou tempo | Dinheiro: F4.2 sobe para a Fase 2 no lugar da F2.3 e a F3.4 usa `--max-budget-usd`. Tempo: F6.3 entra na Fase 2 | |
| D6 | Quantas runs por semana e qual a meta de custo por ticket? | Desconhecido; pilotos com teto de runs e data | Volume baixo (sugestão: menos de 5 runs concluídas por semana) | F3.1 entra na Fase 2 no lugar da F2.3 | |
| D3 | Pin ou checkout? | Modo checkout com ponto de retorno (F1.2) | Voltar ao pin (PRI-371) | F1.2 vira a PRI-371; a Fase 1 ganha 1 cycle | |
| D5 | O que congelar? | Tudo de "Fora do roadmap agora". Nada com issue aberta é removido: o writer de Self-SDD fica (PRI-349 e filhas dão a ele um chamador) e as issues saem do cycle até a Fase 2 fechar. Jev (PRI-321, PRI-291) e verificação de UI (PRI-360, PRI-361) seguem a mesma regra; ver [`LINEAR.md`](LINEAR.md) | Manter uma terceira frente | Não cabe: uma frente deste roadmap precisa sair | |
| D2 | Escopo do Espectro | Só o fluxo de código | Também decidir o que construir | Abre uma frente permanente no lugar da frente B das Fases 3 a 5 | |
| D4 | Primeiro usuário externo | O próprio repo do Espectro é o consumidor piloto (já é assim na PRI-354); ninguém de fora em seis meses | Um colega | Com a premissa, o projeto-amostra da F3.2 pode encolher. Com um colega, F6.11 entra depois da Fase 3 | |
| D7 | Canal de aceite | Redmine continua; a fila é só leitura | Dashboard vira o canal | F6.7 entra na Fase 4, antes da F4.4 | |
| D8 | Exposição pública. Fato conferido em 16/11/2026: o repo no GitHub está público | Não é de propósito; fechar | É de propósito | Varredura de dado do consumidor vira a primeira fatia da Fase 1 | |
| D9 | Mais contato ou menos gates? | Mesmos pontos de decisão, com melhor evidência e aviso | Mais pontos de decisão | F6.8 e F6.9 sobem para a Fase 4 | |
| D10 | Issues Done | Arquivar, nunca apagar | Continuar apagando | Não muda a ordem; tira a confiança das métricas de fluxo | |
| D11 | Os pilotos de decomposição (PRI-341) e de esforço por fase (PRI-354) esperam a Fase 1? | Não. Já têm AUTORIZO e rodam no launcher do piloto, no próprio Espectro; seguem em paralelo com a Fase 1, com a PRI-335 feita antes de ligar a decomposição. "Nenhuma flag antes da Fase 1" vale para o consumidor corporativo (app-back). Recomendação do coordenador | Os pilotos esperam o fim da Fase 1 | Na alternativa, F2.2 e F2.3 voltam a "não iniciada" e a depender de F1.3, F1.5 e F2.1 | 16/11/2026: seguir como for melhor para o projeto. Vale a premissa: em paralelo |
| D12 | Regras de fluxo: mesclar é aceitar no Leve e no Médio, fila "Com o Richard" com limite de três, teto de entrada de issues, piloto no próprio Espectro como Médio | Aprovadas | Manter o Acordo v2 como está | Fatia F0.4; a F0.8 depende delas | 16/11/2026: aprovadas |

## Exceções de gate

Registre aqui quando uma fase abrir sem o critério de saída da anterior: data, fase, o que
ficou pendente e por quê.
