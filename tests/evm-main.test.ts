import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvmService } from "../evm/service.ts";
import { EvmStore } from "../evm/store.ts";
import { OPERATOR_KEY, createEvmConfig } from "./helpers/evm-fixtures.ts";
import { captureConsole, createRestorer, tick, until } from "./helpers/cli.ts";

const restorer = createRestorer();
afterEach(() => restorer.restoreAll());

test("serves the EVM API and ticks until SIGTERM, warning about failed cycles", async () => {
  const directory = mkdtempSync(join(tmpdir(), "timba-evm-main-"));
  restorer.add(() => rmSync(directory, { recursive: true, force: true }));
  const secret = (name: string, value: string) => {
    const path = join(directory, name);
    writeFileSync(path, `${value}\n`, { mode: 0o600 });
    return path;
  };
  const configFile = join(directory, "evm.json");
  writeFileSync(
    configFile,
    JSON.stringify(
      createEvmConfig({
        operatorKeyFile: secret("operator.key", OPERATOR_KEY),
        apiTokenFile: secret("api.token", "evm-token"),
        port: 4555,
      }),
    ),
  );
  const previous = process.env["EVM_CONFIG_FILE"];
  process.env["EVM_CONFIG_FILE"] = configFile;
  restorer.add(() => {
    if (previous === undefined) delete process.env["EVM_CONFIG_FILE"];
    else process.env["EVM_CONFIG_FILE"] = previous;
  });
  const output = captureConsole(restorer);

  const validated = restorer.track(
    spyOn(EvmService.prototype, "validateDeployment").mockResolvedValue(undefined as never),
  );
  let ticks = 0;
  restorer.track(
    spyOn(EvmService.prototype, "tick").mockImplementation(async () => {
      ticks += 1;
      if (ticks <= 2) throw new Error("rpc unavailable");
    }),
  );
  const sleeps: number[] = [];
  restorer.track(
    spyOn(Bun, "sleep").mockImplementation((async (ms: number) => {
      sleeps.push(ms);
      await tick();
    }) as never),
  );
  let fetchHandler: ((request: Request) => Promise<Response>) | undefined;
  let stopped = 0;
  const serve = restorer.track(
    spyOn(Bun, "serve").mockImplementation(((options: {
      fetch: (request: Request) => Promise<Response>;
    }) => {
      fetchHandler = options.fetch;
      return {
        stop: async () => {
          stopped += 1;
        },
      };
    }) as never),
  );
  const signals = new Map<string, () => void>();
  restorer.track(
    spyOn(process, "once").mockImplementation(((event: string, handler: () => void) => {
      signals.set(event, handler);
      return process;
    }) as never),
  );
  const closeStore = restorer.track(spyOn(EvmStore.prototype, "close"));

  const running = import("../evm/main.ts");
  await until(() => ticks >= 3);

  expect(validated).toHaveBeenCalledTimes(1);
  expect(serve).toHaveBeenCalledWith(
    expect.objectContaining({ port: 4555, maxRequestBodySize: 16 * 1024 }),
  );
  const unauthorized = await fetchHandler!(new Request("http://evm/evm/health"));
  expect(unauthorized.status).toBe(401);
  expect(output.log).toEqual([
    "EVM oracle listening on port 4555, chain 31337, proxy 0x1111111111111111111111111111111111111111",
  ]);
  // Two consecutive failures inside a minute produce a single warning.
  expect(output.error).toEqual([["EVM oracle cycle failed; durable work retained for retry"]]);
  expect(sleeps.every((ms) => ms === 250)).toBe(true);
  expect([...signals.keys()].sort()).toEqual(["SIGINT", "SIGTERM"]);

  signals.get("SIGTERM")!();
  await running;

  expect(stopped).toBe(1);
  expect(closeStore).toHaveBeenCalledTimes(1);
});
