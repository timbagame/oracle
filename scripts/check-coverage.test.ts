import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCoverage } from "./check-coverage";

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
