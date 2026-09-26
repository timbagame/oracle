import { describe, expect, spyOn, test } from "bun:test";
import * as kit from "@solana/kit";

const { generateKeyPairSigner, getBase58Decoder } = kit;
import {
  addressBytes,
  addressFromBytes,
  asAddress,
  asSignature,
  base64ToBytes,
  bytesToBase64,
  createRpcSubscriptions,
  createSigner,
  ensureKeyPairSigner,
  fetchAccount,
  parseRpcAccount,
  type OracleRpc,
} from "../solana-kit.ts";
import { Keypair } from "./helpers/solana-fixtures.ts";

function rpcReturning(value: unknown): OracleRpc {
  return {
    getAccountInfo: (_address: string, config: unknown) => {
      expect(config).toEqual({ commitment: "confirmed", encoding: "base64" });
      return { send: async () => value };
    },
  } as unknown as OracleRpc;
}

describe("solana-kit helpers", () => {
  test("round-trips addresses and bytes", async () => {
    const { address } = await generateKeyPairSigner();

    expect(addressFromBytes(addressBytes(address))).toBe(address);
    expect(asAddress(address)).toBe(address);
    expect(() => asAddress("not-an-address")).toThrow();
  });

  test("round-trips base64 payloads", () => {
    const bytes = new Uint8Array([0, 1, 2, 250]);

    expect(bytesToBase64(bytes)).toBe("AAEC+g==");
    expect(Array.from(base64ToBytes("AAEC+g=="))).toEqual([0, 1, 2, 250]);
  });

  test("validates signatures", () => {
    const signature = getBase58Decoder().decode(new Uint8Array(64).fill(4));

    expect(asSignature(signature)).toBe(signature as never);
    expect(() => asSignature("short")).toThrow();
  });

  test("creates signers from secret keys and passes kit signers through", async () => {
    const legacy = Keypair.generate();

    const signer = await createSigner(legacy.secretKey);
    expect(signer.address).toBe(legacy.publicKey.toBase58() as never);
    await expect(ensureKeyPairSigner(legacy)).resolves.toMatchObject({ address: signer.address });
    await expect(ensureKeyPairSigner(signer)).resolves.toBe(signer);
  });

  test("maps RPC endpoints onto websocket subscription endpoints", () => {
    const factory = spyOn(kit, "createSolanaRpcSubscriptions").mockImplementation(((
      url: string,
    ) => ({ url })) as never);
    try {
      expect(createRpcSubscriptions("https://rpc.example/path")).toEqual({
        url: "wss://rpc.example/path",
      } as never);
      expect(createRpcSubscriptions("wss://ws.example")).toEqual({
        url: "wss://ws.example/",
      } as never);
      expect(createRpcSubscriptions("http://127.0.0.1:8899")).toEqual({
        url: "ws://127.0.0.1:8899/",
      } as never);
    } finally {
      factory.mockRestore();
    }
  });
});

describe("fetchAccount", () => {
  test("decodes base64 RPC accounts", async () => {
    const { address } = await generateKeyPairSigner();
    const owner = (await generateKeyPairSigner()).address;
    const rpc = rpcReturning({
      context: { slot: 1n },
      value: {
        data: [Buffer.from([7, 8, 9]).toString("base64"), "base64"],
        owner,
        lamports: 5n,
        executable: false,
        space: 3n,
      },
    });

    const account = await fetchAccount(rpc, address);

    expect(account).toMatchObject({ address, programAddress: owner, lamports: 5n });
    expect(Array.from(account!.data)).toEqual([7, 8, 9]);
  });

  test("returns null for missing accounts", async () => {
    const { address } = await generateKeyPairSigner();

    await expect(fetchAccount(rpcReturning({ value: null }), address)).resolves.toBeNull();
  });

  test("normalizes legacy account doubles with raw bytes and key objects", async () => {
    const { address } = await generateKeyPairSigner();
    const owner = Keypair.generate().publicKey;
    const rpc = rpcReturning({
      data: new Uint8Array([1, 2]),
      executable: true,
      lamports: 9,
      owner,
    });

    await expect(fetchAccount(rpc, address)).resolves.toMatchObject({
      address,
      executable: true,
      lamports: 9n,
      programAddress: owner.toBase58(),
      space: 2n,
    });
  });

  test("accepts string owners and rejects unusable owners", async () => {
    const { address } = await generateKeyPairSigner();
    const owner = (await generateKeyPairSigner()).address;
    const legacy = (value: unknown) =>
      rpcReturning({ data: new Uint8Array([1]), executable: false, lamports: 1, owner: value });

    await expect(fetchAccount(legacy(owner), address)).resolves.toMatchObject({
      programAddress: owner,
    });
    await expect(fetchAccount(legacy(42), address)).rejects.toThrow(
      "Invalid account owner address",
    );
  });
});

test("parseRpcAccount decodes a base64 account", async () => {
  const { address } = await generateKeyPairSigner();
  const owner = (await generateKeyPairSigner()).address;

  const parsed = parseRpcAccount(address, {
    data: [Buffer.from([1]).toString("base64"), "base64"],
    owner,
    lamports: 1n,
    executable: false,
    space: 1n,
  } as never);

  expect(parsed).toMatchObject({ address, programAddress: owner, exists: true });
});
