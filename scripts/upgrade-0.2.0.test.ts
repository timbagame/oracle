import { describe, expect, it } from "bun:test";
import {
  PROGRAM_ID,
  PHASE_HOST,
  PHASES,
  createReleaseBundle,
  extractVerificationJobId,
  nextIncompletePhase,
  remoteVerificationSucceeded,
  sha256,
  stableJson,
  validateReleaseBundle,
  type ReleaseState,
} from "./upgrade-0.2.0";

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
      nextIncompletePhase(
        state({ "local-preflight": { status: "complete", at: "now" } }),
      ),
    ).toBe("prepare");
  });

  it("retries failed and running phases", () => {
    expect(
      nextIncompletePhase(
        state({ "local-preflight": { status: "failed", at: "now" } }),
      ),
    ).toBe("local-preflight");
    expect(
      nextIncompletePhase(
        state({ "local-preflight": { status: "running", at: "now" } }),
      ),
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
    expect(stableJson({ z: 1, a: { y: 2, x: 3 } })).toBe(
      stableJson({ a: { x: 3, y: 2 }, z: 1 }),
    );
  });

  it("creates stable SHA-256 evidence", () => {
    expect(sha256("timba")).toMatch(/^[a-f0-9]{64}$/);
    expect(sha256("timba")).toBe(sha256("timba"));
  });

  it("extracts remote verification job IDs", () => {
    expect(extractVerificationJobId("Job ID: verify_abc-123")).toBe(
      "verify_abc-123",
    );
  });

  it("requires an explicit successful remote verification result", () => {
    expect(remoteVerificationSucceeded("Status: completed successfully")).toBe(
      true,
    );
    expect(remoteVerificationSucceeded("Status: running")).toBe(false);
    expect(remoteVerificationSucceeded("Status: completed with error")).toBe(
      false,
    );
  });
});
