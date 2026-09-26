import { expect, test } from "bun:test";
import * as plans from "@timbagame/protocol/solana/plans";
import { buildWrapSolInstructions, isWrappedSol } from "../web-api/wsol.ts";

test("re-exports the protocol wrapped SOL helpers", () => {
  expect(isWrappedSol).toBe(plans.isWrappedSol);
  expect(buildWrapSolInstructions).toBe(plans.buildWrapSolInstructions);
});
