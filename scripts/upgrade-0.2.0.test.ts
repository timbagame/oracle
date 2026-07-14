import { describe, expect, it } from "bun:test";
import {
  PROGRAM_ID,
  GAME_DISCRIMINATOR,
  LEGACY_GAME_BASE_SIZE,
  PHASE_HOST,
  PHASES,
  createReleaseBundle,
  classifyLegacyGame,
  extractVerificationJobId,
  nextIncompletePhase,
  remoteVerificationSucceeded,
  readEnvValue,
  selectEnv,
  sha256,
  stableJson,
  validateReleaseBundle,
  type ReleaseState,
} from "./upgrade-0.2.0";

function legacyGame(
  overrides: {
    maxTickets?: number;
    ticketsCount?: number;
    totalAmount?: bigint;
    participantHashes?: number;
  } = {},
): Buffer {
  const maxTickets = overrides.maxTickets ?? 2;
  const data = Buffer.alloc(LEGACY_GAME_BASE_SIZE + 4 + maxTickets * 8);
  GAME_DISCRIMINATOR.copy(data, 0);
  data.writeUInt32LE(maxTickets, 49);
  data.writeUInt32LE(overrides.ticketsCount ?? 0, 57);
  data.writeBigUInt64LE(overrides.totalAmount ?? 0n, 118);
  data.writeUInt32LE(overrides.participantHashes ?? 0, 126);
  return data;
}

function state(phases: ReleaseState["phases"] = {}): ReleaseState {
  return {
    version: 2,
    release: "0.2.0",
    programId: PROGRAM_ID,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    phases,
    evidence: {},
  };
}

describe("upgrade state", () => {
  it("requires first IDL publication and both verification phases before migration", () => {
    expect(PHASES).toEqual([
      "local-preflight",
      "prepare",
      "vps-preflight",
      "drain",
      "backup",
      "build",
      "deploy-contract",
      "publish-idl",
      "verify-source",
      "verify-remote",
      "release-clients",
      "migrate-clients",
      "smoke-test",
    ]);
    expect(PHASE_HOST["deploy-contract"]).toBe("local");
    expect(PHASE_HOST["release-clients"]).toBe("local");
    expect(PHASE_HOST["migrate-clients"]).toBe("vps");
  });

  it("resumes at the first incomplete phase", () => {
    expect(nextIncompletePhase(state())).toBe("local-preflight");
    expect(
      nextIncompletePhase(state({ "local-preflight": { status: "complete", at: "now" } })),
    ).toBe("prepare");
  });

  it("retries failed and running phases", () => {
    expect(nextIncompletePhase(state({ "local-preflight": { status: "failed", at: "now" } }))).toBe(
      "local-preflight",
    );
    expect(
      nextIncompletePhase(state({ "local-preflight": { status: "running", at: "now" } })),
    ).toBe("local-preflight");
  });
});

describe("release evidence", () => {
  it("detects modified cross-machine release bundles", () => {
    const original = state({
      "local-preflight": { status: "complete", at: "now" },
    });
    const bundle = createReleaseBundle(original);
    expect(validateReleaseBundle(bundle)).toEqual(original);
    bundle.state.evidence["modified"] = "yes";
    expect(() => validateReleaseBundle(bundle)).toThrow(
      "Invalid or modified Timba release-state bundle",
    );
  });

  it("canonicalizes JSON object key order", () => {
    expect(stableJson({ z: 1, a: { y: 2, x: 3 } })).toBe(stableJson({ a: { x: 3, y: 2 }, z: 1 }));
  });

  it("creates stable SHA-256 evidence", () => {
    expect(sha256("timba")).toMatch(/^[a-f0-9]{64}$/);
    expect(sha256("timba")).toBe(sha256("timba"));
  });

  it("extracts remote verification job IDs", () => {
    expect(extractVerificationJobId("Job ID: verify_abc-123")).toBe("verify_abc-123");
  });

  it("requires an explicit successful remote verification result", () => {
    expect(remoteVerificationSucceeded("Status: completed successfully")).toBe(true);
    expect(remoteVerificationSucceeded("Status: running")).toBe(false);
    expect(remoteVerificationSucceeded("Status: completed with error")).toBe(false);
  });
});

describe("legacy Game drain guard", () => {
  it("accepts an empty old-sized game as inert", () => {
    expect(classifyLegacyGame("game", legacyGame())).toMatchObject({
      dataLength: 146,
      maxTickets: 2,
      ticketsCount: 0,
      totalAmount: 0n,
      participantHashes: 0,
      inert: true,
    });
  });

  it("marks funds, tickets, or participant hashes as actionable", () => {
    expect(classifyLegacyGame("funded", legacyGame({ totalAmount: 1n })).inert).toBe(false);
    expect(classifyLegacyGame("joined", legacyGame({ ticketsCount: 1 })).inert).toBe(false);
    expect(classifyLegacyGame("hashed", legacyGame({ participantHashes: 1 })).inert).toBe(false);
  });

  it("rejects an account whose allocation is not the legacy layout", () => {
    expect(() => classifyLegacyGame("wrong-size", legacyGame().subarray(0, 145))).toThrow(
      "unexpected legacy Game size",
    );
  });
});

describe("legacy Compose environment migration", () => {
  const legacy = [
    "TELEGRAM_TOKEN=telegram",
    'MNEMONIC="one two three"',
    "SOLANA_NETWORK=https://rpc.example",
    "ORACLE_PORT=3001",
    "ORACLE_API_TOKEN=old-token",
    "",
  ].join("\n");

  it("extracts a quoted mnemonic without exposing it in migrated env files", () => {
    expect(readEnvValue(legacy, "MNEMONIC")).toBe("one two three");
    const migrated = selectEnv(legacy, (key) => key !== "MNEMONIC" && key !== "ORACLE_API_TOKEN");
    expect(migrated).toContain("TELEGRAM_TOKEN=telegram");
    expect(migrated).not.toContain("one two three");
    expect(migrated).not.toContain("old-token");
  });

  it("builds a least-privilege oracle environment", () => {
    const migrated = selectEnv(
      legacy,
      (key) =>
        key === "SOLANA_NETWORK" || (key.startsWith("ORACLE_") && key !== "ORACLE_API_TOKEN"),
    );
    expect(migrated).toBe("SOLANA_NETWORK=https://rpc.example\nORACLE_PORT=3001\n");
  });
});
