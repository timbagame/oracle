import { isAbsolute, relative, resolve } from "path";

const THRESHOLD = 95;

type CoverageConfig = {
  roots: string[];
  extensions: string[];
  reportBase?: string;
  exclude?: string[];
};

export type CoverageResult = {
  threshold: number;
  covered: number;
  total: number;
  percent: number;
  missing: string[];
  passed: boolean;
};

function globMatches(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replaceAll("*", ".*").replaceAll("?", ".")}$`).test(value);
}

function isInScope(path: string, config: CoverageConfig): boolean {
  const rooted = config.roots.some((prefix) => {
    const normalized = prefix.replace(/\/+$/, "");
    return normalized === "." || path === normalized || path.startsWith(`${normalized}/`);
  });
  return rooted && !(config.exclude ?? []).some((pattern) => globMatches(path, pattern));
}

function trackedFiles(root: string): string[] {
  const result = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root });
  if (result.exitCode !== 0) {
    throw new Error("Unable to list tracked source files");
  }
  return new TextDecoder()
    .decode(result.stdout)
    .split("\0")
    .filter(Boolean)
    .map((path) => path.replaceAll("\\", "/"));
}

function reportSourcePath(source: string, root: string, reportBase: string): string {
  const absolute = isAbsolute(source) ? resolve(source) : resolve(root, reportBase, source);
  const relativePath = relative(resolve(root), absolute).replaceAll("\\", "/");
  return relativePath === ".." || relativePath.startsWith("../") ? "" : relativePath;
}

export async function checkCoverage(
  config: CoverageConfig,
  reports: string[],
  root: string,
): Promise<CoverageResult> {
  const sources = new Set(
    trackedFiles(root).filter(
      (path) =>
        config.extensions.some((extension) => path.endsWith(extension)) && isInScope(path, config),
    ),
  );
  if (sources.size === 0) {
    throw new Error("No source files matched the coverage scope");
  }

  const lines = new Map<string, boolean>();
  const seen = new Set<string>();
  for (const report of reports) {
    let current: string | undefined;
    let reportLines = 0;
    const contents = await Bun.file(report).text();
    for (const entry of contents.split(/\r?\n/)) {
      if (entry.startsWith("SF:")) {
        const name = reportSourcePath(entry.slice(3), root, config.reportBase ?? ".");
        current = sources.has(name) ? name : undefined;
        if (current) seen.add(current);
      } else if (entry.startsWith("DA:") && current) {
        const [lineNumber, hitCount] = entry.slice(3).split(",");
        if (!/^-?\d+$/.test(lineNumber ?? "") || !/^-?\d+$/.test(hitCount ?? "")) {
          throw new Error("Invalid LCOV line data");
        }
        const number = Number(lineNumber);
        const hits = Number(hitCount);
        if (number <= 0 || hits < 0) {
          throw new Error("Invalid LCOV line data");
        }
        reportLines += 1;
        const key = `${current}\0${number}`;
        lines.set(key, (lines.get(key) ?? false) || hits > 0);
      } else if (entry === "end_of_record") {
        current = undefined;
      }
    }
    if (reportLines === 0) {
      throw new Error(`No scoped line data in ${report}`);
    }
  }

  if (lines.size === 0) {
    throw new Error("No instrumented source lines in coverage reports");
  }
  const missing = [...sources].filter((path) => !seen.has(path)).sort();
  const covered = [...lines.values()].filter(Boolean).length;
  const total = lines.size;
  return {
    threshold: THRESHOLD,
    covered,
    total,
    percent: Math.round((covered * 10000) / total) / 100,
    missing,
    passed: missing.length === 0 && covered * 100 >= THRESHOLD * total,
  };
}

async function main(args: string[]): Promise<number> {
  const [configPath, ...reports] = args;
  if (!configPath || reports.length === 0) {
    console.error("Usage: bun run scripts/check-coverage.ts <config> <lcov-report> [...]");
    return 2;
  }
  const root = process.cwd();
  try {
    const config = (await Bun.file(resolve(root, configPath)).json()) as CoverageConfig;
    const result = await checkCoverage(config, reports, root);
    console.log(JSON.stringify(result, null, 2));
    if (result.missing.length > 0) {
      console.error("Coverage is incomplete: scoped source files are absent from LCOV.");
    }
    return result.passed ? 0 : 1;
  } catch (error) {
    console.error(
      `Coverage gate failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
