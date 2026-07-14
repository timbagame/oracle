import * as anchor from "@anchor-lang/core";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import idl from "../idl/idl.json";
import { classifyLegacyGame, GAME_DISCRIMINATOR } from "./upgrade-0.2.0";

const PROGRAM_ID = new anchor.web3.PublicKey("32Jr4JnXWvqq9GqPQynkooHsszaucUUvZfNLh2hdX2L5");
const LOADER_ID = new anchor.web3.PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const ORACLE_SEED = Buffer.from("oracle");
const DEFAULT_MAINNET_RPC = "https://api.mainnet-beta.solana.com";
const DEFAULT_LOCAL_RPC = "http://127.0.0.1:18999";

type CommandOptions = {
  cwd?: string;
  quiet?: boolean;
};

type SnapshotAccount = {
  pubkey: string;
  account: {
    lamports: number;
    data: [string, "base64"];
    owner: string;
    executable: boolean;
    rentEpoch: number;
    space: number;
  };
};

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

async function command(argv: string[], options: CommandOptions = {}): Promise<string> {
  if (!options.quiet) console.log(`$ ${argv.join(" ")}`);
  const child = Bun.spawn(argv, {
    cwd: options.cwd,
    env: { ...process.env, NO_DNA: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${argv[0]} exited with ${exitCode}: ${stderr || stdout}`);
  if (!options.quiet && stdout.trim()) console.log(stdout.trim());
  return stdout.trim();
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function accountJson(
  pubkey: anchor.web3.PublicKey,
  info: anchor.web3.AccountInfo<Buffer>,
): SnapshotAccount {
  return {
    pubkey: pubkey.toBase58(),
    account: {
      lamports: info.lamports,
      data: [info.data.toString("base64"), "base64"],
      owner: info.owner.toBase58(),
      executable: info.executable,
      // Mainnet returns u64::MAX for rent-exempt accounts, which JavaScript cannot
      // serialize as an exact integer. Rent epoch does not affect account behavior here.
      rentEpoch: 0,
      space: info.data.length,
    },
  };
}

async function waitForValidator(
  connection: anchor.web3.Connection,
  logFile: string,
): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await connection.getVersion();
      return;
    } catch {
      // Validator is still starting.
    }
    await Bun.sleep(500);
  }
  throw new Error(`Local validator did not become healthy. Log: ${logFile}`);
}

async function waitForProgramActivation(
  connection: anchor.web3.Connection,
  programDataAddress: anchor.web3.PublicKey,
): Promise<void> {
  const info = await connection.getAccountInfo(programDataAddress, "confirmed");
  if (!info) throw new Error("Local ProgramData account disappeared after upgrade");
  const deploymentSlot = Number(info.data.readBigUInt64LE(4));
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if ((await connection.getSlot("confirmed")) > deploymentSlot) return;
    await Bun.sleep(500);
  }
  throw new Error(`Upgraded program did not activate after deployment slot ${deploymentSlot}`);
}

function patchProgramDataAuthority(data: Buffer, authority: anchor.web3.PublicKey): Buffer {
  const patched = Buffer.alloc(data.length);
  patched.set(data);
  if (patched.length < 45 || patched.readUInt32LE(0) !== 3 || patched[12] !== 1)
    throw new Error("Unexpected upgradeable ProgramData layout");
  patched.writeBigUInt64LE(0n, 4);
  authority.toBuffer().copy(patched, 13);
  return patched;
}

function patchOracleOperator(data: Buffer, operator: anchor.web3.PublicKey): Buffer {
  const patched = Buffer.alloc(data.length);
  patched.set(data);
  if (patched.length !== 69) throw new Error(`Unexpected Oracle account size ${patched.length}`);
  operator.toBuffer().copy(patched, 8);
  return patched;
}

async function assertAccountBytes(
  connection: anchor.web3.Connection,
  expected: Map<string, Buffer>,
): Promise<void> {
  for (const [address, bytes] of expected) {
    const info = await connection.getAccountInfo(new anchor.web3.PublicKey(address), "confirmed");
    if (!info) throw new Error(`Snapshot account disappeared: ${address}`);
    if (!info.owner.equals(PROGRAM_ID))
      throw new Error(`Snapshot account owner changed: ${address}`);
    if (!info.data.equals(bytes)) throw new Error(`Snapshot account data changed: ${address}`);
  }
}

function closeRpcWebSocket(connection: anchor.web3.Connection | undefined): void {
  if (!connection) return;
  const websocket = (
    connection as unknown as {
      _rpcWebSocket?: { close(): void };
    }
  )._rpcWebSocket;
  websocket?.close();
}

async function main(): Promise<void> {
  const oracleRoot = resolve(import.meta.dir, "..");
  const workspaceRoot = dirname(oracleRoot);
  const contractsRoot = join(workspaceRoot, "contracts");
  const rpcUrl = option("--rpc-url") ?? DEFAULT_MAINNET_RPC;
  const localRpc = option("--local-rpc") ?? DEFAULT_LOCAL_RPC;
  const requestedBinary = option("--binary");
  const requestedWorkDir = option("--work-dir");
  const keep = process.argv.includes("--keep") || Boolean(requestedWorkDir);
  const workDir = requestedWorkDir
    ? resolve(requestedWorkDir.replace(/^~/, homedir()))
    : await mkdtemp(join(tmpdir(), "timba-upgrade-simulation-"));
  const binary = resolve(requestedBinary ?? join(contractsRoot, "target", "deploy", "timba.so"));
  const snapshotDir = join(workDir, "accounts");
  const ledgerDir = join(workDir, "ledger");
  const authorityFile = join(workDir, "local-upgrade-authority.json");
  const bufferFile = join(workDir, "local-upgrade-buffer.json");
  const deployedBinary = join(workDir, "mainnet-0.1.3.so");
  const beforeDump = join(workDir, "local-before.so");
  const afterDump = join(workDir, "local-after.so");
  const validatorLog = join(workDir, "validator.log");

  await mkdir(snapshotDir, { recursive: true });
  await command([
    "solana-keygen",
    "new",
    "--no-bip39-passphrase",
    "--silent",
    "--force",
    "-o",
    authorityFile,
  ]);
  await command([
    "solana-keygen",
    "new",
    "--no-bip39-passphrase",
    "--silent",
    "--force",
    "-o",
    bufferFile,
  ]);
  await chmod(authorityFile, 0o600);
  await chmod(bufferFile, 0o600);
  const authorityAddress = await command(["solana", "address", "-k", authorityFile], {
    quiet: true,
  });
  const authority = new anchor.web3.PublicKey(authorityAddress);
  const authorityKeypair = anchor.web3.Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(await readFile(authorityFile, "utf8")) as number[]),
  );

  console.log(`Simulation directory: ${workDir}`);
  console.log(`Mainnet RPC: ${rpcUrl}`);
  console.log(`Disposable authority: ${authorityAddress}`);

  if (!requestedBinary)
    await command(["anchor", "build", "--program-name", "timba"], { cwd: contractsRoot });
  await command([
    "solana",
    "program",
    "dump",
    PROGRAM_ID.toBase58(),
    deployedBinary,
    "--url",
    rpcUrl,
  ]);
  const currentBinary = await readFile(deployedBinary);
  const upgradeBinary = await readFile(binary);
  if (currentBinary.equals(upgradeBinary))
    throw new Error("Upgrade binary equals deployed 0.1.3 binary");

  const mainnet = new anchor.web3.Connection(rpcUrl, "finalized");
  const [programDataAddress] = anchor.web3.PublicKey.findProgramAddressSync(
    [PROGRAM_ID.toBuffer()],
    LOADER_ID,
  );
  const [oracleAddress] = anchor.web3.PublicKey.findProgramAddressSync([ORACLE_SEED], PROGRAM_ID);
  const [programInfo, programDataInfo, ownedAccounts] = await Promise.all([
    mainnet.getAccountInfo(PROGRAM_ID, "finalized"),
    mainnet.getAccountInfo(programDataAddress, "finalized"),
    mainnet.getProgramAccounts(PROGRAM_ID, { commitment: "finalized" }),
  ]);
  if (!programInfo || !programDataInfo)
    throw new Error("Mainnet program or ProgramData account is missing");
  if (!programInfo.owner.equals(LOADER_ID) || !programDataInfo.owner.equals(LOADER_ID))
    throw new Error("Unexpected mainnet upgradeable-loader ownership");

  const snapshotInputs: Array<[anchor.web3.PublicKey, anchor.web3.AccountInfo<Buffer>]> = [
    [PROGRAM_ID, programInfo],
    [
      programDataAddress,
      { ...programDataInfo, data: patchProgramDataAuthority(programDataInfo.data, authority) },
    ],
  ];
  const expectedOwned = new Map<string, Buffer>();
  const legacyGames: Array<ReturnType<typeof classifyLegacyGame>> = [];
  for (const entry of ownedAccounts) {
    const originalData = Buffer.from(entry.account.data);
    const data = entry.pubkey.equals(oracleAddress)
      ? patchOracleOperator(originalData, authority)
      : originalData;
    if (data.subarray(0, 8).equals(GAME_DISCRIMINATOR))
      legacyGames.push(classifyLegacyGame(entry.pubkey.toBase58(), data));
    expectedOwned.set(entry.pubkey.toBase58(), data);
    snapshotInputs.push([entry.pubkey, { ...entry.account, data }]);
  }

  const accountArgs: string[] = [];
  for (const [pubkey, info] of snapshotInputs) {
    const file = join(snapshotDir, `${pubkey.toBase58()}.json`);
    await writeFile(file, `${JSON.stringify(accountJson(pubkey, info), null, 2)}\n`);
    accountArgs.push("--account", pubkey.toBase58(), file);
  }

  const manifestFile = join(workDir, "manifest.json");
  const manifest: Record<string, unknown> = {
    source: rpcUrl,
    programId: PROGRAM_ID.toBase58(),
    programData: programDataAddress.toBase58(),
    oracle: oracleAddress.toBase58(),
    accountCount: ownedAccounts.length,
    legacyGames: legacyGames.map((game) => ({
      ...game,
      totalAmount: game.totalAmount.toString(),
    })),
    intentionalMutations: {
      programUpgradeAuthority: authorityAddress,
      programDeploymentSlot: 0,
      oracleOperator: authorityAddress,
    },
    hashes: {
      deployedProgram: sha256(currentBinary),
      upgradeProgram: sha256(upgradeBinary),
    },
    result: "running",
  };
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  const actionableGames = legacyGames.filter((game) => !game.inert);
  if (actionableGames.length > 0)
    throw new Error(
      `Mainnet snapshot contains actionable legacy games: ${actionableGames
        .map((game) => game.address)
        .join(", ")}`,
    );

  const logHandle = Bun.file(validatorLog);
  const validator = Bun.spawn(
    [
      "solana-test-validator",
      "--reset",
      "--ledger",
      ledgerDir,
      "--rpc-port",
      new URL(localRpc).port || "18999",
      "--faucet-port",
      "19999",
      "--dynamic-port-range",
      "19000-19899",
      ...accountArgs,
    ],
    {
      env: { ...process.env, NO_DNA: "1" },
      stdout: logHandle,
      stderr: logHandle,
    },
  );

  let local: anchor.web3.Connection | undefined;
  try {
    local = new anchor.web3.Connection(localRpc, "confirmed");
    await waitForValidator(local, validatorLog);
    await command(["solana", "airdrop", "100", authorityAddress, "--url", localRpc]);
    await assertAccountBytes(local, expectedOwned);
    await command([
      "solana",
      "program",
      "dump",
      PROGRAM_ID.toBase58(),
      beforeDump,
      "--url",
      localRpc,
    ]);
    const localBefore = await readFile(beforeDump);
    if (!localBefore.equals(currentBinary))
      throw new Error("Local pre-upgrade executable differs from mainnet");

    console.log("\nUpgrading the cloned program locally...");
    await command([
      "solana",
      "program",
      "deploy",
      binary,
      "--program-id",
      PROGRAM_ID.toBase58(),
      "--upgrade-authority",
      authorityFile,
      "--buffer",
      bufferFile,
      "--keypair",
      authorityFile,
      "--url",
      localRpc,
      "--use-rpc",
    ]);
    await command([
      "solana",
      "program",
      "dump",
      PROGRAM_ID.toBase58(),
      afterDump,
      "--url",
      localRpc,
    ]);
    const localAfter = await readFile(afterDump);
    if (!localAfter.equals(upgradeBinary))
      throw new Error("Local post-upgrade executable differs from 0.2.0 binary");
    await assertAccountBytes(local, expectedOwned);
    await waitForProgramActivation(local, programDataAddress);

    const wallet = new anchor.Wallet(authorityKeypair);
    const provider = new anchor.AnchorProvider(local, wallet, { commitment: "confirmed" });
    const program = new anchor.Program(idl as anchor.Idl, provider);
    const accountClients = program.account as unknown as Record<
      string,
      { fetch(address: anchor.web3.PublicKey): Promise<Record<string, unknown>> }
    >;
    const oracleClient = accountClients["oracle"];
    if (!oracleClient) throw new Error("0.2.0 IDL does not expose the Oracle account");
    const oracleBefore = await oracleClient.fetch(oracleAddress);
    const config = {
      feePercentage: oracleBefore["feePercentage"],
      oracleBufferTime: oracleBefore["oracleBufferTime"],
      maxTickets: oracleBefore["maxTickets"],
      maxTimeout: oracleBefore["maxTimeout"],
      minTimeout: oracleBefore["minTimeout"],
    };
    const updateOracle = program.methods["updateOracle"];
    if (!updateOracle) throw new Error("0.2.0 IDL does not expose updateOracle");
    const oracleSignature = await updateOracle(config)
      .accounts({
        oracle: oracleAddress,
        oldOracleOperator: authority,
        newOracleOperator: authority,
      })
      .signers([authorityKeypair])
      .rpc();
    const oracleAfter = await oracleClient.fetch(oracleAddress);
    if (JSON.stringify(oracleBefore) !== JSON.stringify(oracleAfter))
      throw new Error("No-op Oracle update changed account data");

    manifest["result"] = "passed";
    manifest["oracleInstructionSignature"] = oracleSignature;
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

    console.log("\nSimulation passed");
    console.log(`- Exact mainnet 0.1.3 executable loaded: ${sha256(currentBinary)}`);
    console.log(`- Local 0.2.0 executable deployed: ${sha256(upgradeBinary)}`);
    console.log(`- ${ownedAccounts.length} Timba-owned accounts preserved byte-for-byte`);
    console.log(
      `- ${legacyGames.length} legacy Game accounts remain inert at their original allocation`,
    );
    console.log("- Existing Oracle account accepts a 0.2.0 instruction after the upgrade");
    console.log(`- Evidence: ${manifestFile}`);
  } finally {
    closeRpcWebSocket(local);
    validator.kill();
    await validator.exited;
    if (!keep) await rm(workDir, { recursive: true, force: true });
    else console.log(`Kept simulation artifacts in ${workDir}`);
  }
}

await main();
