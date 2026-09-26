import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { loadConfig, loadSecret, tokenPolicy } from "../evm/config.ts";

const folders: string[] = [];
afterEach(() => {
  while (folders.length > 0) rmSync(folders.pop()!, { recursive: true, force: true });
});

function writeFile(name: string, contents: string, mode = 0o600): string {
  const folder = mkdtempSync(resolve(tmpdir(), "timba-evm-config-"));
  folders.push(folder);
  const path = resolve(folder, name);
  writeFileSync(path, contents);
  chmodSync(path, mode);
  return path;
}

const example = JSON.parse(
  readFileSync(resolve(import.meta.dir, "../evm/config.example.json"), "utf8"),
) as Record<string, unknown>;

describe("loadConfig", () => {
  test("parses the example deployment config", () => {
    const config = loadConfig(writeFile("config.json", JSON.stringify(example)));

    expect(config).toMatchObject({ chainId: 31337, confirmations: 2, pollMs: 2000, port: 3002 });
    expect(config.tokens).toHaveLength(1);
  });

  test("rejects duplicate token policies", () => {
    const token = (example["tokens"] as unknown[])[0];
    const path = writeFile("config.json", JSON.stringify({ ...example, tokens: [token, token] }));

    expect(() => loadConfig(path)).toThrow("Duplicate token policy");
  });

  test("rejects unknown keys", () => {
    const path = writeFile("config.json", JSON.stringify({ ...example, secret: "nope" }));

    expect(() => loadConfig(path)).toThrow();
  });
});

describe("loadSecret", () => {
  test("reads a private secret file without surrounding whitespace", () => {
    expect(loadSecret(writeFile("secret", "  token-value\n"))).toBe("token-value");
  });

  test("rejects group or world readable secret files", () => {
    expect(() => loadSecret(writeFile("secret", "token", 0o644))).toThrow(
      "EVM secret files must be private regular files (mode 600 or 400)",
    );
  });

  test("rejects oversized secret files", () => {
    expect(() => loadSecret(writeFile("secret", "x".repeat(4097)))).toThrow(
      "EVM secret files must be private regular files",
    );
  });

  test("rejects empty secret files", () => {
    expect(() => loadSecret(writeFile("secret", "  \n"))).toThrow("Empty EVM secret file");
  });
});

describe("tokenPolicy", () => {
  test("matches token addresses regardless of checksum casing", () => {
    const config = loadConfig(writeFile("config.json", JSON.stringify(example)));

    expect(tokenPolicy(config, "0x2222222222222222222222222222222222222222").symbol).toBe("TEST");
    expect(() => tokenPolicy(config, "0x3333333333333333333333333333333333333333")).toThrow(
      "Unsupported EVM token",
    );
  });
});
