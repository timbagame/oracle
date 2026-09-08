import { expect, test } from "bun:test";
import { createRpc, sendRpcRequest } from "../solana-kit";

for (const host of ["mainnet.helius-rpc.com", "backup.helius-rpc.com", "unrelated.test"]) {
  test(`routes submissions with rebate only for Helius: ${host}`, async () => {
    const previousFetch = globalThis.fetch;
    const previousRebate = process.env["HELIUS_REBATE_ADDRESS"];
    const calls: URL[] = [];
    globalThis.fetch = (async (input: any, init: any) => {
      calls.push(new URL(String(input)));
      const body = JSON.parse(init.body);
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: body.method === "getSlot" ? 12 : "1".repeat(64),
      });
    }) as unknown as typeof fetch;
    process.env["HELIUS_REBATE_ADDRESS"] = "recipient";
    try {
      const rpc = createRpc(`https://${host}/?api-key=test`);
      await sendRpcRequest(rpc.sendTransaction("AA==" as never, { encoding: "base64" }));
      await sendRpcRequest(rpc.getSlot());
      expect(calls[0]!.searchParams.get("rebate-address")).toBe(
        host.endsWith("helius-rpc.com") ? "recipient" : null,
      );
      expect(calls[0]!.searchParams.get("api-key")).toBe("test");
      expect(calls[1]!.searchParams.has("rebate-address")).toBe(false);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousRebate === undefined) delete process.env["HELIUS_REBATE_ADDRESS"];
      else process.env["HELIUS_REBATE_ADDRESS"] = previousRebate;
    }
  });
}
