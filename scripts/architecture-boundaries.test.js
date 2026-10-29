"use strict";

/**
 * PRI-104 / F02B — teste de arquitetura (node:test).
 * Roda dependency-cruiser com --ignore-known; falha em violação nova.
 * Ratchet: o baseline versionado só pode encolher (shrink-only).
 * Injeção sintética: expected FAILED.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO =
  process.env.PRISMA_ROOT ||
  process.env.REPO_PATH ||
  path.resolve(__dirname, "..");
const SCRIPTS = path.join(REPO, "scripts");
const CONFIG = path.join(REPO, ".dependency-cruiser.cjs");
const BASELINE = path.join(REPO, ".dependency-cruiser-known-violations.json");
const DEPCRUISE = path.join(SCRIPTS, "node_modules", ".bin", "depcruise");

function runDepcruise(args, { cwd = REPO } = {}) {
  const result = spawnSync(DEPCRUISE, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  return {
    status: result.status === null ? 1 : result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function countBaselineViolations(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  // Formato dependency-cruiser: array de violações ou { violations: [...] }
  if (Array.isArray(raw)) return raw.length;
  if (Array.isArray(raw.violations)) return raw.violations.length;
  if (Array.isArray(raw.summary?.violations)) {
    return raw.summary.violations.length;
  }
  // known-violations.json tipicamente é lista plana de { from, to, rule }
  throw new Error(
    `Formato de baseline não reconhecido em ${filePath}: chaves=${Object.keys(raw)}`
  );
}

const OWNERSHIP = path.join(REPO, "ownership.yaml");

describe("PRI-104 architecture boundaries", () => {
  it("baseline file exists and is non-empty", () => {
    assert.ok(fs.existsSync(BASELINE), `missing ${BASELINE}`);
    const n = countBaselineViolations(BASELINE);
    assert.ok(n > 0, "baseline should record current known violations");
  });

  it("ownership.yaml exists with UNKNOWN owners (D12)", () => {
    assert.ok(fs.existsSync(OWNERSHIP), `missing ${OWNERSHIP}`);
    const text = fs.readFileSync(OWNERSHIP, "utf8");
    assert.match(text, /owner:\s*UNKNOWN/, "expected at least one owner: UNKNOWN");
    assert.match(text, /confirmation:\s*\n\s*status:\s*PENDING/, "D12 confirmation PENDING");
    // Não promover owner inventado nesta fatia
    assert.doesNotMatch(
      text,
      /owner:\s*DOM\d+/i,
      "owners DOM* só após confirmação Arquiteto/PRI-84/85"
    );
  });

  it("depcruise with --ignore-known exits 0 (no new violations)", () => {
    assert.ok(fs.existsSync(DEPCRUISE), "dependency-cruiser not installed in scripts/");
    const r = runDepcruise([
      "-c",
      CONFIG,
      "--ignore-known",
      BASELINE,
      "--no-cache",
      "scripts",
      "dashboard",
    ]);
    assert.equal(
      r.status,
      0,
      `new violations detected:\n${r.stdout}\n${r.stderr}`
    );
  });

  it("baseline shrink-only: regenerating must not grow", () => {
    const before = countBaselineViolations(BASELINE);
    const tmp = path.join(
      os.tmpdir(),
      `pri104-baseline-${process.pid}-${Date.now()}.json`
    );
    try {
      const r = runDepcruise([
        "-c",
        CONFIG,
        "--baseline",
        tmp,
        "--baseline-mode",
        "full",
        "--no-cache",
        "scripts",
        "dashboard",
      ]);
      // --baseline exits 0 after writing even when violations exist
      assert.ok(
        fs.existsSync(tmp),
        `baseline regenerate failed:\n${r.stdout}\n${r.stderr}`
      );
      const after = countBaselineViolations(tmp);
      assert.ok(
        after <= before,
        `baseline grew: was ${before}, now ${after} (ratchet violated)`
      );
      // Se o scan atual for estritamente menor, o arquivo versionado está
      // desatualizado para cima — também é falha (deve encolher via commit).
      // Igualdade é o estado esperado do ratchet estável.
      assert.equal(
        after,
        before,
        `baseline drift: versioned=${before} current=${after}; update with shrink-only if fixed, never grow`
      );
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  it("synthetic new violation fails (expected: FAILED)", () => {
    // Injeta CJS (não TS): dependency-cruiser 18 ainda não transpila typescript@7
    // (aviso missing-tsc-transpiler). A regra de camada é a mesma.
    const injDir = fs.mkdtempSync(path.join(os.tmpdir(), "pri104-inj-"));
    const stageRoot = path.join(injDir, "repo");
    const stageScriptsSrc = path.join(stageRoot, "scripts", "src");
    fs.mkdirSync(path.join(stageScriptsSrc, "domain"), { recursive: true });
    fs.mkdirSync(path.join(stageScriptsSrc, "adapters"), { recursive: true });
    fs.writeFileSync(
      path.join(stageScriptsSrc, "adapters", "stub.js"),
      "module.exports = { stub: 1 };\n"
    );
    fs.writeFileSync(
      path.join(stageScriptsSrc, "domain", "bad.js"),
      'const { stub } = require("../adapters/stub");\nmodule.exports = { x: stub };\n'
    );
    const stageConfig = path.join(stageRoot, ".dependency-cruiser.cjs");
    fs.writeFileSync(
      stageConfig,
      `module.exports = {
  forbidden: [{
    name: "domain-no-outer",
    severity: "error",
    from: { path: "scripts/src/domain/" },
    to: { path: "scripts/src/adapters/" },
  }],
  options: {
    doNotFollow: { path: "node_modules" },
    moduleSystems: ["cjs", "es6"],
  },
};
`
    );
    try {
      const r = runDepcruise(
        [
          "-c",
          stageConfig,
          "--no-cache",
          path.join(stageRoot, "scripts", "src"),
        ],
        { cwd: stageRoot }
      );
      assert.notEqual(
        r.status,
        0,
        `synthetic domain→adapters import should FAIL depcruise\n${r.stdout}\n${r.stderr}`
      );
      assert.match(
        `${r.stdout}\n${r.stderr}`,
        /domain-no-outer/i,
        `expected domain-no-outer in output:\n${r.stdout}\n${r.stderr}`
      );
    } finally {
      fs.rmSync(injDir, { recursive: true, force: true });
    }
  });
});
