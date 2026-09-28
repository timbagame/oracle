import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

/**
 * In-process tests import each script's exported functions, so the one-line `import.meta.main`
 * guards only run when a script is the process entrypoint. These run the real `bun run <script>`
 * on argument errors that are rejected before any network or database access.
 */
const ROOT = fileURLToPath(new URL("..", import.meta.url));

function runScript(script: string, ...args: string[]) {
  const result = Bun.spawnSync([process.execPath, "run", script, ...args], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: "test" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe("script entrypoints", () => {
  test("check-coverage exits with code 2 and prints usage without arguments", () => {
    const result = runScript("scripts/check-coverage.ts");

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(
      "Usage: bun run scripts/check-coverage.ts <config> <lcov-report> [...]",
    );
    expect(result.stdout).toBe("");
  });

  test("oracle-admin exits with code 2 and prints usage without a command", () => {
    const result = runScript("scripts/oracle-admin.ts");

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("bun run admin token-policy set <mint> <on|off>");
  });

  test("import-indexer fails with usage without a D1 export", () => {
    const result = runScript("scripts/import-indexer.ts");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Usage: bun run indexer:import <d1-export.sql> [indexer.sqlite]",
    );
  });

  test("audit-random exits with code 1 on an unknown argument", () => {
    const result = runScript("scripts/audit-random.ts", "--bogus");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("audit-random failed: Unknown argument: --bogus");
  });

  test.each([
    ["scripts/attempt-completion.ts", "Usage: bun run scripts/attempt-completion.ts <gameAddress>"],
    ["scripts/inspect-game.ts", "Usage: bun run scripts/inspect-game.ts <gameAddress>"],
  ])("%s exits with code 1 and prints usage without a game", (script, usage) => {
    const result = runScript(script);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(usage);
  });
});
