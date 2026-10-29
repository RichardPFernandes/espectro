/**
 * PRI-104 / F02B — ESLint flat só em src/** TS (ADR-09 / §3.2).
 *
 * typescript-eslint@8 ainda recusa typescript@7 (PRI-103 / issue #10940).
 * Parser: @babel/eslint-parser + preset-typescript — mesmas restrições de
 * camada (no-restricted-imports / process.env / no any via TSAnyKeyword).
 * Dependências do ESLint vivem em scripts/node_modules (sem runner de raiz).
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const requireFromScripts = createRequire(
  path.join(__dirname, "scripts", "package.json")
);
const babelParser = requireFromScripts("@babel/eslint-parser");

const NODE_IO_PATHS = [
  "fs",
  "fs/promises",
  "node:fs",
  "node:fs/promises",
  "child_process",
  "node:child_process",
  "http",
  "https",
  "net",
  "node:http",
  "node:https",
  "node:net",
];

const layerParser = {
  languageOptions: {
    parser: babelParser,
    parserOptions: {
      requireConfigFile: false,
      babelOptions: {
        presets: [
          requireFromScripts.resolve("@babel/preset-typescript"),
        ],
      },
      sourceType: "module",
      ecmaVersion: "latest",
    },
  },
};

const noExplicitAny = [
  "error",
  {
    selector: "TSAnyKeyword",
    message: "any explícito é erro em src/ (F02B / ADR-09).",
  },
];

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "scripts/lib/**",
      "dashboard/public/**",
      "**/*.js",
      "**/*.cjs",
      // este arquivo
      "eslint.config.mjs",
    ],
  },
  {
    files: ["scripts/src/**/*.ts", "dashboard/src/**/*.ts"],
    ...layerParser,
    rules: {
      "no-restricted-syntax": noExplicitAny,
    },
  },
  {
    files: [
      "scripts/src/domain/**/*.ts",
      "scripts/src/application/**/*.ts",
    ],
    ...layerParser,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: NODE_IO_PATHS.map((name) => ({
            name,
            message:
              "domain/application não importam IO de Node; use ports + adapters.",
          })),
        },
      ],
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "env",
          message: "process.env só em config/, composition/ ou platform/roots (F02).",
        },
      ],
      "no-restricted-syntax": noExplicitAny,
    },
  },
  {
    files: [
      "scripts/src/ports/**/*.ts",
      "scripts/src/adapters/**/*.ts",
      "scripts/src/interface/**/*.ts",
    ],
    ...layerParser,
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "env",
          message: "process.env só em config/, composition/ ou platform/roots (F02).",
        },
      ],
      "no-restricted-syntax": noExplicitAny,
    },
  },
];
