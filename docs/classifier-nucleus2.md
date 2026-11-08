# Núcleo 2 do roteamento: Jev em modo sombra

PRI-205 S3b. Spec: [SPEC.md](../SPEC.md) (§B1–B11). Plano e evidência:
`tasks/pri-205-s3b/`. Escrito em 2026-11-08.

## O que faz

Em Runs com roteamento ligado (`mode = ON`), o Prisma pode perguntar ao Jev
(TypeSafe) a classe de alguns grupos do Implement, **antes do spawn**:

- grupos da zona cinzenta (G1/G2), que hoje caem em C4 (Opus);
- grupos C1–C3, como sonda de subida (G3).

A resposta fica **só como registro**, na RoutingDecision (`nucleus2`,
`classifier_ref`) e num Attempt de efeito próprio (`node = classifier`). A
classe, o modelo e o argv continuam saindo só do núcleo 1 (R1–R8). O objetivo é
acumular dado de calibração (custo × qualidade) antes de qualquer decisão de dar
efeito ao Jev.

## Contenção: desligado por padrão

Depois do merge, nada é enviado até as quatro condições abaixo existirem. Sem
qualquer uma delas, o núcleo 2 fica `off` com o motivo no snapshot da Run, e o
despacho é o de hoje.

| Condição | Onde | Motivo quando falta |
| -- | -- | -- |
| Authority Ref durável e o espelho no consumidor | Coordenador (DP-7) + `.claude/classifier-authority.json` | `AUTHORITY_REF_ABSENT` |
| Referência da credencial no config | `.claude/model-routing.json` → `classifier_credential` | `CREDENTIAL_REF_ABSENT` |
| Item no Keychain com a chave | Keychain do usuário que roda o watcher | grupo com `CREDENTIAL_UNAVAILABLE`, nada é enviado |
| Seleção "Policy + Jev" | Dashboard (seletor) → `memory/routing/classifier-selection.json` | vale a policy (`cheap_rule`: só núcleo 1) |

A policy aprovada `routing-pri205@p1-2026-11-06` **não muda**: os parâmetros do
Jev vêm da plataforma e ficam no registro de seleção (Q12).

## Ativação

Sempre nesta ordem:

1. **Authority Ref.** O Coordenador registra a Authority Ref no Linear (DP-7). O
   consumidor guarda o espelho em `.claude/classifier-authority.json`:

   ```json
   {
     "id": "<id registrado>",
     "issued_by": "Richard Fernandes",
     "issued_at": "2026-10-26",
     "source": ["PRI-205 D20 (2026-10-20)", "PRI-205 U-A1 (2026-10-26)", "R-2/R-3 (2026-10-26/27)"],
     "destination": "typesafe:/v1/systemone",
     "envelope": {
       "allow": ["step_text", "ac_text", "declared_paths"],
       "never": ["code", "customer_data", "personal_data", "secrets", "credentials"]
     },
     "scope": { "projects": ["app-back"] },
     "valid_from": "2026-10-26T00:00:00.000Z",
     "revoked_at": null
   }
   ```

   O nome em `scope.projects` é o da pasta do consumidor (`app-back`).

2. **Referências no config.** Em `.claude/model-routing.json`, acrescente só os
   nomes e a referência com hash (nunca a chave):

   ```json
   {
     "mode": "ON",
     "policy_ref": { "...": "como hoje" },
     "classifier_credential": { "keychain": "prisma-jev-typesafe", "account": "typesafe" },
     "authority_ref": { "id": "<id>", "sha256": "<sha256 dos bytes do espelho>", "path": ".claude/classifier-authority.json" }
   }
   ```

   O hash é o dos bytes exatos do espelho: `shasum -a 256 .claude/classifier-authority.json`.

3. **Chave no Keychain.** Rode o comando abaixo como o usuário que roda o
   watcher. O `-w` no fim faz o `security` pedir a chave no terminal, então ela
   não fica no histórico do shell nem em arquivo:

   ```bash
   security add-generic-password -s prisma-jev-typesafe -a typesafe -w
   ```

   Não copie a chave do `settings.json` da conta do Claude para nenhum arquivo do
   repositório. Na primeira leitura, o macOS pode perguntar se o
   `/usr/bin/security` pode acessar o item: escolha "Permitir sempre". Se a
   leitura pedir diálogo durante um tick, o grupo fica `CREDENTIAL_UNAVAILABLE` e
   nada é enviado.

4. **Teste de fumaça (P-3).** Uma chamada real, com um envelope sintético
   embutido (sem texto de ticket):

   ```bash
   REPO_PATH=<raiz do consumidor> node "$PRISMA_ROOT/scripts/jev-calibrate.js" --synthetic --out /tmp/jev-smoke --max-calls 1 --n 2
   ```

   Com `--synthetic`, o comando usa a seção do Jev da plataforma mesmo antes da
   seleção (passo 5), para provar a API antes de qualquer texto de ticket sair.
   Ele exige os passos 1 a 3: sem Authority Ref válida sai com o código 3, sem
   enviar. O relatório mostra a classe devolvida, sem texto.

5. **Seleção.** No Dashboard, escolha "Policy + Jev" (sombra). A troca vale só
   para Runs novas; Runs em andamento mantêm o snapshot.

## Desligar

No Dashboard, escolha "Só policy". Também vale para Runs novas. Para cortar o
envio já no próximo Attempt das Runs em andamento, revogue a Authority Ref:
escreva `revoked_at` no espelho. Qualquer mudança nos bytes do espelho para o
envio a partir do próximo Attempt (Q4).

## Onde ficam os dados (todos no consumidor)

| Dado | Caminho | Conteúdo |
| -- | -- | -- |
| Seleção (append-only) | `memory/routing/classifier-selection.json` | escolha, autor, data, motivo, versão anterior |
| Envelope enviado | `<run>/dom06/classifier/envelopes/<sha256>.json` | texto do passo, ACs, caminhos declarados (para o U15) |
| Efeito por chamada | `<run>/dom06/attempts/<id>.json` (`node = classifier`) | hash do envelope, classe, confianças, desfecho; nunca o texto nem a chave |
| Desligamento por 401/403 | `<run>/dom06/classifier-disabled.json` | motivo e Attempt |

`memory/routing/` deve ficar **fora do git** do consumidor. Acrescente ao
`.gitignore` do app-back:

```gitignore
memory/routing/
```

O GET `/api/routing/classifier` informa `registry_git_ignored`, e a tela avisa
quando o registro pode entrar no git.

## Reprodutibilidade (U15)

```bash
REPO_PATH=<raiz do consumidor> node "$PRISMA_ROOT/scripts/jev-calibrate.js" --runs <consumidor>/memory/runs --max-calls <k> [--n 5]
```

- Repete cada envelope gravado N vezes e mede quantas entradas devolvem o mesmo enum em todas as N. O limiar é 95%.
- `--max-calls` é obrigatório: cada chamada gasta o saldo da conta.
- Com dado faltante, o veredito é `UNKNOWN`, nunca `PASS`. Rodar de novo completa só o que faltou.
- As repetições ficam em `<runs>/_jev-u15/` (ou `--out`), fora dos Attempts das Runs.

## Falhas

| Situação | Efeito |
| -- | -- |
| Verificador de conteúdo acha algo (e-mail, CPF, chave…) | grupo `CONTENT_GUARD_BLOCKED`, nada enviado |
| Passo com bloco de código | grupo `NO_ENVELOPE` (`STEP_HAS_CODE_BLOCK`) |
| Timeout (3 s) ou conexão caída depois do envio | efeito `UNCERTAIN`, **nunca** repetido |
| 401/403 | núcleo 2 `off` no resto da Run |
| Registro de seleção ilegível | núcleo 2 `off` (`CLASSIFIER_SELECTION_INVALID`); o writer recusa sobrescrever |

Em nenhum caso o despacho é bloqueado, e em nenhum caso a classe muda.
