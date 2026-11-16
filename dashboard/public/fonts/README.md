# Fontes locais do dashboard

Servidas pelo próprio dashboard para a tela não depender de rede (PRI-390). Licença SIL OFL 1.1
(`OFL-Inter.txt`, `OFL-JetBrainsMono.txt`). Cada arquivo foi extraído sem alteração do zip da
release oficial. Para conferir: `shasum -a 256 dashboard/public/fonts/*.woff2`.

- `InterVariable.woff2`: Inter 4.1, eixo `wght` 100–900. Do `web/InterVariable.woff2` em https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip (zip sha256 `9883fdd4a49d4fb66bd8177ba6625ef9a64aa45899767dde3d36aa425756b11e`). sha256 `693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3`
- `JetBrainsMono-Regular.woff2`: JetBrains Mono 2.304, peso 400. Do `fonts/webfonts/` em https://github.com/JetBrains/JetBrainsMono/releases/download/v2.304/JetBrainsMono-2.304.zip (zip sha256 `6f6376c6ed2960ea8a963cd7387ec9d76e3f629125bc33d1fdcd7eb7012f7bbf`). sha256 `a9cb1cd82332b23a47e3a1239d25d13c86d16c4220695e34b243effa999f45f2`
- `JetBrainsMono-Medium.woff2`: JetBrains Mono 2.304, peso 500. Mesma release. https://github.com/JetBrains/JetBrainsMono/releases/download/v2.304/JetBrainsMono-2.304.zip. sha256 `086c48dfbea9ddaff1320f7e09399b8e2924e88ce67453721255db3bdbb5a353`
- `JetBrainsMono-SemiBold.woff2`: JetBrains Mono 2.304, peso 600. Mesma release. https://github.com/JetBrains/JetBrainsMono/releases/download/v2.304/JetBrainsMono-2.304.zip. sha256 `918edad542a1da608fd2ba8daebaff9ac802309103fe760eed465b8b4e47faf1`

A release do JetBrains Mono não traz `woff2` variável, só `.ttf`. Por isso entram os três pesos
estáticos que o Google Fonts entregava (400, 500 e 600), sem conversão local.
