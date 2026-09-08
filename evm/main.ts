import { loadConfig, loadSecret } from "./config.ts";
import { EvmService } from "./service.ts";
import { EvmStore } from "./store.ts";
import { createEvmRouter } from "./server.ts";

const path = process.env["EVM_CONFIG_FILE"];
if (!path) throw new Error("EVM_CONFIG_FILE is required");
const config = loadConfig(path);
const key = loadSecret(config.operatorKeyFile);
if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("Invalid EVM operator key file");
const store = new EvmStore(
  config.database,
  `${config.chainId}:${config.address.toLowerCase()}:${config.version}`,
);
const service = new EvmService(config, key as `0x${string}`, store);
await service.validateDeployment();
const server = Bun.serve({
  port: config.port,
  maxRequestBodySize: 16 * 1024,
  fetch: createEvmRouter(service, loadSecret(config.apiTokenFile)),
});
let stopping = false;
let lastWarning = 0;
const stop = () => {
  stopping = true;
  void server.stop();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
console.log(
  `EVM oracle listening on port ${config.port}, chain ${config.chainId}, proxy ${config.address}`,
);
while (!stopping) {
  try {
    await service.tick();
  } catch {
    if (Date.now() - lastWarning > 60_000) {
      lastWarning = Date.now();
      console.error("EVM oracle cycle failed; durable work retained for retry");
    }
  }
  if (!stopping) await Bun.sleep(config.pollMs);
}
store.close();
