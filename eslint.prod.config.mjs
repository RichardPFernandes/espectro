// PRI-406 / F0.7: ESLint só de erros (eslint:recommended) no JavaScript de produção de scripts/ e
// dashboard/. Violações existentes: scripts/lint-baseline.json, que só encolhe (scripts/run-eslint-prod.js).
// O TypeScript de src/ segue no eslint.config.mjs. Dependências em scripts/node_modules.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const requireFromScripts = createRequire(
  path.join(__dirname, "scripts", "package.json")
);
const js = requireFromScripts("@eslint/js");
const globals = requireFromScripts("globals");

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/*.test.js",
      "scripts/fixtures/**",
      "scripts/harness/**",
    ],
  },
  {
    files: ["scripts/**/*.{js,cjs}", "dashboard/**/*.{js,cjs}"],
    ...js.configs.recommended,
    languageOptions: {
      sourceType: "commonjs",
      ecmaVersion: "latest",
      globals: { ...globals.node },
    },
  },
  {
    // Navegador: scripts clássicos que usam globais do script inline do index.html (no-undef fora).
    files: ["dashboard/public/**/*.js"],
    languageOptions: {
      sourceType: "script",
      ecmaVersion: "latest",
      globals: { ...globals.browser },
    },
    rules: { "no-undef": "off" },
  },
];
