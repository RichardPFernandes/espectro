# Histórico de trabalho

Pastas de issues fechadas (SPEC, plano, tarefas, handoff e evidência), movidas de `tasks/`
quando a issue foi para Done ou Canceled. Não há nada aqui a seguir: é registro.

- Uma pasta por issue, `pri-NNN/`. A exceção é o `SPEC-pri-205-s3b.md` solto.
- Os caminhos `tasks/<pasta>/...` dentro destes arquivos mostram onde cada um morava na
  época. Não foram reescritos. Hoje o arquivo está em `docs/historico/pri-NNN/`; a pasta
  `tasks/pri-287-s5/` virou `docs/historico/pri-287/`, e a de `f1-5-custo-por-ticket` virou
  `pri-381/`.
- `pri-233/` também guarda a matriz de evidência da PRI-233 (`evidence.md`).
- `pri-396/` guarda a SPEC, o plano e as tarefas da C1. A `PROPOSTA.md` das fatias C2 a C4
  segue em `tasks/spec-viva-do-espectro/`, porque essas fatias estão em curso.
- Regra: pasta de issue em curso fica em `tasks/`. Ao fechar a issue, vai para cá. Se o
  código ou um teste cita um arquivo por caminho, ele fica onde está. Uma SPEC que ainda é o
  contrato de uma issue aberta também fica (a `SPEC.md` da PRI-287, até a PRI-312 fechar).
