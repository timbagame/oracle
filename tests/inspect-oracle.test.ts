import { afterEach, expect, spyOn, test } from "bun:test";
import * as contractClient from "@timbagame/protocol/contracts/client";
import { OracleService } from "../oracle-service.ts";
import { getConfig } from "../config.ts";
import { main } from "../scripts/inspect-oracle.ts";
import { captureConsole, createRestorer } from "./helpers/cli.ts";
import { setupTestEnvironment } from "./helpers/setup-env.ts";

const PROGRAM = "11111111111111111111111111111111";
const ORACLE_PDA = "32Jr4JnXWvqq9GqPQynkooHsszaucUUvZfNLh2hdX2L5";
const restorer = createRestorer();
afterEach(() => restorer.restoreAll());

test("prints the oracle account derived from the program id", async () => {
  const env = setupTestEnvironment({ prefix: "inspect-oracle" });
  restorer.add(() => env.cleanup());
  const output = captureConsole(restorer);
  const connection = { rpc: true };
  let stopped = 0;
  restorer.track(
    spyOn(OracleService, "getInstance").mockResolvedValue({
      getProgramId: () => PROGRAM,
      getConnection: () => connection,
      stopEventListening: async () => {
        stopped += 1;
      },
    } as never),
  );
  const clientFor = restorer.track(
    spyOn(contractClient, "getContractClient").mockReturnValue({
      findOraclePda: async ({ programAddress }: { programAddress: string }) => {
        expect(programAddress).toBe(PROGRAM);
        return [ORACLE_PDA, 255];
      },
      fetchOracle: async (rpc: unknown, pda: string, config: unknown) => {
        expect(rpc).toBe(connection);
        expect(pda).toBe(ORACLE_PDA);
        expect(config).toEqual({ commitment: "confirmed" });
        return { data: { operatorCount: 1 } };
      },
    } as never),
  );

  await main([]);

  expect(stopped).toBe(1);
  expect(output.error).toEqual([]);
  expect(clientFor).toHaveBeenCalledWith(getConfig().contractVersion);
  expect(output.log.map((line) => JSON.parse(line))).toEqual([
    { oracleAddress: ORACLE_PDA, account: { operatorCount: 1 } },
  ]);
});

test("reports failures to load the oracle account", async () => {
  const output = captureConsole(restorer);
  let stopped = 0;
  restorer.track(
    spyOn(OracleService, "getInstance").mockResolvedValue({
      getProgramId: () => {
        throw new Error("program unavailable");
      },
      stopEventListening: async () => {
        stopped += 1;
        throw new Error("already stopped");
      },
    } as never),
  );

  await main([]);

  expect(output.error).toEqual([["Failed to inspect oracle:", expect.any(Error)]]);
  expect(stopped).toBe(1);
});
