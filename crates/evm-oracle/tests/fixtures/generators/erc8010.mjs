// Records what viem's verifyHash sends and decides for ERC-8010 wrapped signatures.
// Run: bun add viem@2.57.7 ox@0.14.56 && bun erc8010.mjs > ../erc8010.json
// The key is anvil's public test account #1 (fake data).
import { createPublicClient, custom, defineChain, encodeAbiParameters } from "viem";
import { Authorization, Secp256k1 } from "ox";
import { SignatureErc8010 } from "ox/erc8010";

const key = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const delegation = "0x1111111111111111111111111111111111111111";
const hash = `0x${"22".repeat(32)}`;
const inner = `0x${"33".repeat(65)}`;
const chain = defineChain({ id: 31337, name: "t", nativeCurrency: { name: "E", symbol: "E", decimals: 18 }, rpcUrls: { default: { http: ["http://x"] } } });

function wrap(init) {
  const auth = Authorization.from({ address: delegation, chainId: 31337, nonce: 4n });
  const signature = Secp256k1.sign({ payload: Authorization.getSignPayload(auth), privateKey: key });
  return SignatureErc8010.wrap({ authorization: Authorization.from(auth, { signature }), signature: inner, ...init });
}

async function run(wrapped, code, answer) {
  const requests = [];
  const client = createPublicClient({
    chain,
    transport: custom({
      async request({ method, params }) {
        requests.push({ method, params });
        if (method === "eth_getCode") return code;
        if (method === "eth_call") return answer(params);
        throw new Error(`unexpected ${method}`);
      },
    }),
  });
  const account = Secp256k1.getPublicKey({ privateKey: key });
  const { Address } = await import("ox");
  const address = Address.fromPublicKey(account);
  const valid = await client.verifyHash({ address, hash, signature: wrapped }).then((v) => v, (e) => `error: ${e.shortMessage ?? e.message}`);
  return { address, valid, requests };
}

const ok = encodeAbiParameters([{ type: "tuple[]", components: [{ type: "bool" }, { type: "bytes" }] }], [[[true, `0x1626ba7e${"00".repeat(28)}`]]]);
const bad = encodeAbiParameters([{ type: "tuple[]", components: [{ type: "bool" }, { type: "bytes" }] }], [[[true, "0x"], [false, "0x1234"]]]);
const withInit = wrap({ to: "0x4444444444444444444444444444444444444444", data: "0xdeadbeef" });
const plain = wrap({});
const out = {
  generatedBy: "crates/evm-oracle/tests/fixtures/generators/erc8010.mjs (viem 2.57.7, ox 0.14.56)",
  key,
  delegation,
  hash,
  inner,
  answers: { ok, bad },
  withInit,
  plain,
  deployless: await run(withInit, "0x", () => ok),
  rejected: await run(plain, "0x", () => bad),
  delegated: await run(plain, `0xef0100${delegation.slice(2)}`, () => `0x1626ba7e${"00".repeat(28)}`),
  callFails: await run(plain, "0x", () => { throw Object.assign(new Error("boom"), { code: -32000 }); }),
};
out.callFails = { valid: out.callFails.valid.startsWith("error") ? "error" : out.callFails.valid };
console.log(JSON.stringify(out, null, 1));
