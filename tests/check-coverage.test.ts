import { expect, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCoverage, main } from "../scripts/check-coverage.ts";

async function git(root: string, ...args: string[]): Promise<void> {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}

function report(hits: Iterable<number>): string {
  const covered = new Set(hits);
  return `SF:src/a.ts\n${Array.from({ length: 100 }, (_, index) => {
    const line = index + 1;
    return `DA:${line},${covered.has(line) ? 1 : 0}`;
  }).join("\n")}\nend_of_record\n`;
}

test("enforces the threshold and validates merged LCOV reports", async () => {
  const root = await mkdtemp(join(tmpdir(), "timba-coverage-gate-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/a.ts"), "synthetic\n".repeat(100));
    await git(root, "init", "-q");
    await git(root, "add", ".");
    const config: Parameters<typeof checkCoverage>[0] = { roots: ["src"], extensions: [".ts"] };
    const low = join(root, "low.info");
    const exact = join(root, "exact.info");
    const extra = join(root, "extra.info");
    await writeFile(low, report(Array.from({ length: 94 }, (_, index) => index + 1)));
    await writeFile(exact, report(Array.from({ length: 95 }, (_, index) => index + 1)));
    await writeFile(extra, report([95]));
    expect((await checkCoverage(config, [low], root)).passed).toBe(false);
    expect((await checkCoverage(config, [exact], root)).passed).toBe(true);
    expect((await checkCoverage(config, [low, extra], root)).passed).toBe(true);

    const bad = join(root, "bad.info");
    await writeFile(bad, "SF:src/a.ts\nDA:1,-1\nend_of_record\n");
    await expect(checkCoverage(config, [bad], root)).rejects.toThrow("Invalid LCOV line data");

    await writeFile(join(root, "src/tiny.ts"), "synthetic");
    await git(root, "add", ".");
    const weighted = join(root, "weighted.info");
    await writeFile(
      weighted,
      `${await Bun.file(low).text()}SF:src/tiny.ts\nDA:1,1\nend_of_record\n`,
    );
    expect((await checkCoverage(config, [weighted], root)).passed).toBe(false);
    config.exclude = ["src/tiny.ts"];

    await expect(checkCoverage(config, [join(root, "absent")], root)).rejects.toThrow();
    const empty = join(root, "empty.info");
    await writeFile(empty, "");
    await expect(checkCoverage(config, [exact, empty], root)).rejects.toThrow(
      "No scoped line data",
    );

    await writeFile(join(root, "src/missing.ts"), "synthetic");
    await git(root, "add", ".");
    expect((await checkCoverage(config, [exact], root)).passed).toBe(false);
    config.exclude = ["src/tiny.ts", "src/missing.ts"];
    expect((await checkCoverage(config, [exact], root)).passed).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects unusable scopes, repositories and LCOV data", async () => {
  const root = await mkdtemp(join(tmpdir(), "timba-coverage-errors-"));
  try {
    const config: Parameters<typeof checkCoverage>[0] = { roots: ["src"], extensions: [".ts"] };
    await expect(checkCoverage(config, [], root)).rejects.toThrow(
      "Unable to list tracked source files",
    );

    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/a.ts"), "synthetic\n");
    await git(root, "init", "-q");
    await git(root, "add", ".");
    await expect(checkCoverage({ ...config, roots: ["lib"] }, [], root)).rejects.toThrow(
      "No source files matched the coverage scope",
    );
    await expect(checkCoverage(config, [], root)).rejects.toThrow(
      "No instrumented source lines in coverage reports",
    );

    const malformed = join(root, "malformed.info");
    await writeFile(malformed, "SF:src/a.ts\nDA:x,1\nend_of_record\n");
    await expect(checkCoverage(config, [malformed], root)).rejects.toThrow(
      "Invalid LCOV line data",
    );
    await writeFile(malformed, "SF:src/a.ts\nDA:0,1\nend_of_record\n");
    await expect(checkCoverage(config, [malformed], root)).rejects.toThrow(
      "Invalid LCOV line data",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the CLI prints usage, results and failures with matching exit codes", async () => {
  const root = await mkdtemp(join(tmpdir(), "timba-coverage-cli-"));
  const previous = process.cwd();
  const logs: string[] = [];
  const errors: string[] = [];
  const log = spyOn(console, "log").mockImplementation((value: unknown) => {
    logs.push(String(value));
  });
  const error = spyOn(console, "error").mockImplementation((value: unknown) => {
    errors.push(String(value));
  });
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/a.ts"), "synthetic\n".repeat(100));
    await writeFile(join(root, "src/b.ts"), "synthetic\n");
    await git(root, "init", "-q");
    await git(root, "add", ".");
    await writeFile(
      join(root, "scope.json"),
      JSON.stringify({ roots: ["src"], extensions: [".ts"] }),
    );
    await writeFile(
      join(root, "all.json"),
      JSON.stringify({ roots: ["src/a.ts"], extensions: [".ts"] }),
    );
    await writeFile(join(root, "full.info"), report(Array.from({ length: 100 }, (_, i) => i + 1)));
    process.chdir(root);

    expect(await main([])).toBe(2);
    expect(errors.shift()).toStartWith("Usage:");

    expect(await main(["all.json", "full.info"])).toBe(0);
    expect(JSON.parse(logs.pop()!)).toMatchObject({ percent: 100, passed: true });

    expect(await main(["scope.json", "full.info"])).toBe(1);
    expect(JSON.parse(logs.pop()!)).toMatchObject({ missing: ["src/b.ts"], passed: false });
    expect(errors.shift()).toBe(
      "Coverage is incomplete: scoped source files are absent from LCOV.",
    );

    expect(await main(["missing.json", "full.info"])).toBe(1);
    expect(errors.shift()).toStartWith("Coverage gate failed:");
  } finally {
    process.chdir(previous);
    log.mockRestore();
    error.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
