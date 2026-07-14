import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const PROGRAM_ID = "32Jr4JnXWvqq9GqPQynkooHsszaucUUvZfNLh2hdX2L5";
export const RELEASE_VERSION = "0.2.0";
export const LEGACY_GAME_BASE_SIZE = 126;
export const GAME_DISCRIMINATOR = createHash("sha256")
  .update("account:Game")
  .digest()
  .subarray(0, 8);

export interface LegacyGameStatus {
  address: string;
  dataLength: number;
  maxTickets: number;
  ticketsCount: number;
  totalAmount: bigint;
  participantHashes: number;
  expectedDataLength: number;
  inert: boolean;
}

export function classifyLegacyGame(
  address: string,
  data: Uint8Array,
): LegacyGameStatus {
  const bytes = Buffer.from(data);
  if (bytes.length < LEGACY_GAME_BASE_SIZE + 4)
    throw new Error(`${address}: legacy Game account is truncated`);
  if (!bytes.subarray(0, 8).equals(GAME_DISCRIMINATOR))
    throw new Error(`${address}: invalid Game discriminator`);

  const maxTickets = bytes.readUInt32LE(49);
  const ticketsCount = bytes.readUInt32LE(57);
  const totalAmount = bytes.readBigUInt64LE(118);
  const participantHashes = bytes.readUInt32LE(126);
  const expectedDataLength =
    LEGACY_GAME_BASE_SIZE + 4 + maxTickets * BigUint64Array.BYTES_PER_ELEMENT;
  if (bytes.length !== expectedDataLength)
    throw new Error(
      `${address}: unexpected legacy Game size ${bytes.length}; expected ${expectedDataLength}`,
    );
  if (participantHashes > maxTickets)
    throw new Error(
      `${address}: participant hash count ${participantHashes} exceeds max tickets ${maxTickets}`,
    );

  return {
    address,
    dataLength: bytes.length,
    maxTickets,
    ticketsCount,
    totalAmount,
    participantHashes,
    expectedDataLength,
    inert: ticketsCount === 0 && totalAmount === 0n && participantHashes === 0,
  };
}

async function verifyLegacyGamesAreInert(
  options: Options,
  state: ReleaseState,
): Promise<void> {
  const response = await fetch(options.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getProgramAccounts",
      params: [
        PROGRAM_ID,
        {
          encoding: "base64",
          commitment: "finalized",
          filters: [
            {
              memcmp: {
                offset: 0,
                bytes: "G1qmfUpkeRI",
              },
            },
          ],
        },
      ],
    }),
  });
  if (!response.ok)
    throw new Error(`Mainnet RPC returned HTTP ${response.status}`);
  const payload = (await response.json()) as {
    error?: { message?: string };
    result?: Array<{ pubkey: string; account: { data: [string, string] } }>;
  };
  if (payload.error)
    throw new Error(
      `Mainnet RPC failed: ${payload.error.message ?? "unknown error"}`,
    );
  if (!payload.result)
    throw new Error("Mainnet RPC omitted getProgramAccounts result");

  const games = payload.result.map(({ pubkey, account }) =>
    classifyLegacyGame(pubkey, Buffer.from(account.data[0], "base64")),
  );
  const actionable = games.filter((game) => !game.inert);
  state.evidence["drain.legacy-games"] = JSON.stringify(
    games.map((game) => ({
      ...game,
      totalAmount: game.totalAmount.toString(),
    })),
  );
  console.log(
    `Mainnet legacy Game accounts: ${games.length}; inert: ${games.length - actionable.length}; actionable: ${actionable.length}`,
  );
  if (actionable.length > 0) {
    const details = actionable
      .map(
        (game) =>
          `${game.address} (tickets=${game.ticketsCount}, hashes=${game.participantHashes}, total=${game.totalAmount})`,
      )
      .join(", ");
    throw new Error(
      `Cannot upgrade while legacy games remain actionable: ${details}`,
    );
  }
}

export const PHASES = [
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
] as const;

type Phase = (typeof PHASES)[number];
export type ReleaseHost = "local" | "vps";
export const PHASE_HOST: Record<Phase, ReleaseHost> = {
  "local-preflight": "local",
  prepare: "local",
  "vps-preflight": "vps",
  drain: "vps",
  backup: "vps",
  build: "local",
  "deploy-contract": "local",
  "publish-idl": "local",
  "verify-source": "local",
  "verify-remote": "local",
  "release-clients": "local",
  "migrate-clients": "vps",
  "smoke-test": "vps",
};
type SpecialCommand = "status" | "resume" | "export-bundle" | "import-bundle";
type PhaseStatus = "running" | "complete" | "failed";

export interface ReleaseState {
  version: 2;
  release: string;
  programId: string;
  createdAt: string;
  updatedAt: string;
  phases: Partial<
    Record<Phase, { status: PhaseStatus; at: string; error?: string }>
  >;
  evidence: Record<string, string>;
}

interface Options {
  command: Phase | SpecialCommand;
  execute: boolean;
  approvals: Set<string>;
  sourceRoot: string;
  deployRoot: string;
  releaseDir: string;
  stateFile: string;
  rpcUrl: string;
  authority?: string;
  clientBranch: string;
  contractsCommit?: string;
  verificationJobId?: string;
  bundleFile: string;
  host?: ReleaseHost;
}

interface Command {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  captureAs?: string;
}

const now = () => new Date().toISOString();

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function extractVerificationJobId(output: string): string | undefined {
  return output.match(
    /(?:job(?:\s+id)?|job_id)[\s:=\"']+([A-Za-z0-9_-]+)/i,
  )?.[1];
}

export function remoteVerificationSucceeded(output: string): boolean {
  const normalized = output.toLowerCase();
  if (/failed|error|rejected/.test(normalized)) return false;
  return /success|succeeded|verified|completed/.test(normalized);
}

export function nextIncompletePhase(state: ReleaseState): Phase | undefined {
  return PHASES.find((phase) => state.phases[phase]?.status !== "complete");
}

function parseArgs(argv: string[]): Options {
  const command = argv[0] as Options["command"] | undefined;
  if (
    !command ||
    ![...PHASES, "status", "resume", "export-bundle", "import-bundle"].includes(
      command,
    )
  )
    usage();

  const value = (name: string) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const approvals = new Set<string>();
  argv.forEach((arg, index) => {
    const approval = argv[index + 1];
    if (arg === "--approve" && approval) approvals.add(approval);
  });

  const host = value("--host");
  if (host && host !== "local" && host !== "vps") usage();
  const home = process.env["HOME"] ?? "";
  const defaultSourceRoot =
    host === "vps" ? join(home, "timba") : resolve(import.meta.dir, "../..");

  const sourceRoot = resolve(
    value("--source-root") ?? process.env["SOURCE_ROOT"] ?? defaultSourceRoot,
  );
  const deployRoot = resolve(
    value("--deploy-root") ?? process.env["DEPLOY_ROOT"] ?? join(home, "timba"),
  );
  const releaseDir = resolve(
    value("--release-dir") ??
      process.env["RELEASE_DIR"] ??
      join(home || sourceRoot, `timba-release-${RELEASE_VERSION}`),
  );
  return {
    command,
    execute: argv.includes("--execute"),
    approvals,
    sourceRoot,
    deployRoot,
    releaseDir,
    stateFile: resolve(
      value("--state") ?? join(releaseDir, "release-state.json"),
    ),
    rpcUrl:
      value("--rpc-url") ??
      process.env["RPC_URL"] ??
      "https://api.mainnet-beta.solana.com",
    authority: value("--authority") ?? process.env["UPGRADE_AUTHORITY"],
    clientBranch:
      value("--client-branch") ??
      process.env["CLIENT_BRANCH"] ??
      "contracts-0.2.0-compat",
    contractsCommit:
      value("--contracts-commit") ?? process.env["CONTRACTS_COMMIT"],
    verificationJobId:
      value("--verification-job-id") ?? process.env["VERIFICATION_JOB_ID"],
    bundleFile: resolve(
      value("--bundle") ?? join(releaseDir, "release-state.bundle.json"),
    ),
    host: host as ReleaseHost | undefined,
  };
}

function usage(): never {
  console.error(`Usage: bun run upgrade:0.2.0 <phase|status|resume|export-bundle|import-bundle> [options]

Phases: ${PHASES.join(", ")}

Safe by default: commands are printed unless --execute is supplied.
Irreversible phases additionally require --approve <phase>.

Common options:
  --execute
  --approve drain|deploy-contract|publish-idl|verify-source|verify-remote|migrate-clients|smoke-test
  --source-root PATH   --deploy-root PATH   --release-dir PATH
  --authority PATH     --rpc-url URL         --state PATH
  --bundle PATH
  --host local|vps
  --verification-job-id ID`);
  process.exit(2);
}

async function loadState(options: Options): Promise<ReleaseState> {
  try {
    return JSON.parse(
      await readFile(options.stateFile, "utf8"),
    ) as ReleaseState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {
      version: 2,
      release: RELEASE_VERSION,
      programId: PROGRAM_ID,
      createdAt: now(),
      updatedAt: now(),
      phases: {},
      evidence: {},
    };
  }
}

async function saveState(options: Options, state: ReleaseState): Promise<void> {
  state.updatedAt = now();
  await mkdir(dirname(options.stateFile), { recursive: true });
  await writeFile(options.stateFile, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(options.stateFile, 0o600);
}

export interface ReleaseBundle {
  kind: "timba-0.2.0-release-state";
  version: 1;
  checksum: string;
  state: ReleaseState;
}

export function createReleaseBundle(state: ReleaseState): ReleaseBundle {
  return {
    kind: "timba-0.2.0-release-state",
    version: 1,
    checksum: sha256(stableJson(state)),
    state,
  };
}

export function validateReleaseBundle(bundle: ReleaseBundle): ReleaseState {
  if (
    bundle.kind !== "timba-0.2.0-release-state" ||
    bundle.version !== 1 ||
    bundle.state.version !== 2 ||
    bundle.state.release !== RELEASE_VERSION ||
    bundle.state.programId !== PROGRAM_ID ||
    bundle.checksum !== sha256(stableJson(bundle.state))
  )
    throw new Error("Invalid or modified Timba release-state bundle");
  return bundle.state;
}

async function exportBundle(
  options: Options,
  state: ReleaseState,
): Promise<void> {
  await mkdir(dirname(options.bundleFile), { recursive: true });
  await writeFile(
    options.bundleFile,
    `${JSON.stringify(createReleaseBundle(state), null, 2)}\n`,
    { mode: 0o600 },
  );
  await chmod(options.bundleFile, 0o600);
  console.log(`Exported non-secret release state to ${options.bundleFile}`);
}

async function importBundle(options: Options): Promise<void> {
  const bundle = JSON.parse(
    await readFile(options.bundleFile, "utf8"),
  ) as ReleaseBundle;
  const imported = validateReleaseBundle(bundle);
  const current = await loadState(options);
  const completed = (state: ReleaseState) =>
    PHASES.filter((phase) => state.phases[phase]?.status === "complete").length;
  if (completed(current) > completed(imported))
    throw new Error(
      "Refusing to replace newer local release state with an older bundle",
    );
  await saveState(options, imported);
  console.log(`Imported verified release state into ${options.stateFile}`);
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@=-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;
}

async function run(
  command: Command,
  options: Options,
  state: ReleaseState,
): Promise<string> {
  const cwd = command.cwd ?? options.sourceRoot;
  console.log(
    `\n$ cd ${shellQuote(cwd)} && ${command.argv.map(shellQuote).join(" ")}`,
  );
  if (!options.execute) return "";

  const executable = command.argv[0];
  if (!executable) throw new Error("Cannot execute an empty command");
  const child = Bun.spawn([executable, ...command.argv.slice(1)], {
    cwd,
    env: { ...process.env, NO_DNA: "1", ...command.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  if (exitCode !== 0)
    throw new Error(`${command.argv[0]} exited with status ${exitCode}`);
  const output = stdout.trim();
  if (command.captureAs) state.evidence[command.captureAs] = output;
  return output;
}

function requireApproval(
  options: Options,
  phase: Phase,
  summary: string,
): void {
  console.log(`\nAPPROVAL GATE: ${summary}`);
  if (options.execute && !options.approvals.has(phase)) {
    throw new Error(
      `Refusing to execute ${phase}; rerun with --approve ${phase}`,
    );
  }
}

function path(options: Options, project: string): string {
  return join(options.sourceRoot, project);
}

async function assertFileMode(file: string): Promise<void> {
  const info = await lstat(file);
  const mode = info.mode & 0o777;
  if (
    info.isSymbolicLink() ||
    !info.isFile() ||
    (mode !== 0o400 && mode !== 0o600)
  ) {
    throw new Error(`${file} must be a regular file with mode 400 or 600`);
  }
}

async function localPreflight(
  options: Options,
  state: ReleaseState,
): Promise<void> {
  for (const project of ["contracts", "oracle", "bot", "timba-web-cf"]) {
    await stat(path(options, project));
  }
  for (const tool of [
    "anchor",
    "solana",
    "solana-verify",
    "bun",
    "jq",
    "sha256sum",
  ]) {
    await run(
      { argv: ["sh", "-c", `command -v ${tool}`], captureAs: `tool.${tool}` },
      options,
      state,
    );
  }
  const anchorVersion = await run(
    { argv: ["anchor", "--version"], captureAs: "anchor.version" },
    options,
    state,
  );
  const solanaVersion = await run(
    { argv: ["solana", "--version"], captureAs: "solana.version" },
    options,
    state,
  );
  if (options.execute && !anchorVersion.includes("1.1.2"))
    throw new Error(`Expected Anchor 1.1.2, got ${anchorVersion}`);
  if (options.execute && !solanaVersion.includes("3.1.10"))
    throw new Error(`Expected Solana 3.1.10, got ${solanaVersion}`);
  for (const project of ["contracts", "oracle", "bot", "timba-web-cf"]) {
    const dirty = await run(
      {
        argv: ["git", "status", "--porcelain"],
        cwd: path(options, project),
        captureAs: `${project}.dirty`,
      },
      options,
      state,
    );
    if (options.execute && dirty)
      throw new Error(`${project} worktree is not clean`);
  }
  if (options.authority) {
    const authority = await run(
      {
        argv: ["solana", "address", "-k", options.authority],
        captureAs: "authority.address",
      },
      options,
      state,
    );
    await run(
      {
        argv: [
          "solana",
          "balance",
          "-k",
          options.authority,
          "--url",
          options.rpcUrl,
        ],
        captureAs: "authority.balance",
      },
      options,
      state,
    );
    const program = await run(
      {
        argv: [
          "solana",
          "program",
          "show",
          PROGRAM_ID,
          "--url",
          options.rpcUrl,
        ],
        captureAs: "program.preflight",
      },
      options,
      state,
    );
    if (options.execute && !program.includes(authority))
      throw new Error(`Program authority does not match ${authority}`);
  }
}

async function vpsPreflight(
  options: Options,
  state: ReleaseState,
): Promise<void> {
  for (const project of ["oracle", "bot"]) {
    await stat(path(options, project));
  }
  for (const project of ["oracle", "bot"]) {
    await stat(join(options.deployRoot, project, "compose.yml"));
  }
  for (const tool of [
    "cosign",
    "docker",
    "podman",
    "bun",
    "sqlite3",
    "sha256sum",
    "cmp",
    "systemctl",
    "journalctl",
  ]) {
    await run(
      {
        argv: ["sh", "-c", `command -v ${tool}`],
        captureAs: `vps.tool.${tool}`,
      },
      options,
      state,
    );
  }
  await run(
    {
      argv: ["docker", "compose", "version"],
      captureAs: "docker.compose.version",
    },
    options,
    state,
  );
  const rootless = await run(
    {
      argv: ["podman", "info", "--format", "{{.Host.Security.Rootless}}"],
      captureAs: "podman.rootless",
    },
    options,
    state,
  );
  if (options.execute && rootless !== "true")
    throw new Error("Podman must run rootless on the VPS");
  for (const project of ["oracle", "bot"]) {
    const dirty = await run(
      {
        argv: ["git", "status", "--porcelain"],
        cwd: path(options, project),
      },
      options,
      state,
    );
    if (options.execute && dirty)
      throw new Error(`${project} VPS worktree is not clean`);
  }
  for (const project of ["oracle", "bot"]) {
    await run(
      {
        argv: ["docker", "compose", "ps", "--format", "json"],
        cwd: join(options.deployRoot, project),
        captureAs: `docker.${project}.preflight`,
      },
      options,
      state,
    );
  }
}

async function prepare(options: Options, state: ReleaseState): Promise<void> {
  for (const project of ["contracts", "oracle", "bot", "timba-web-cf"]) {
    const ahead = await run(
      {
        argv: ["git", "rev-list", "--count", "@{upstream}..HEAD"],
        cwd: path(options, project),
      },
      options,
      state,
    );
    if (options.execute && ahead !== "0")
      throw new Error(`${project} has ${ahead} unpushed commit(s)`);
  }
  const commands: Command[] = [
    {
      argv: ["git", "rev-parse", "HEAD"],
      cwd: path(options, "contracts"),
      captureAs: "contracts.commit",
    },
    { argv: ["bun", "run", "typecheck"], cwd: path(options, "contracts") },
    { argv: ["bun", "run", "lint"], cwd: path(options, "contracts") },
    {
      argv: ["anchor", "test"],
      cwd: path(options, "contracts"),
      env: { NO_DNA: "1" },
    },
    { argv: ["bun", "run", "typecheck"], cwd: path(options, "oracle") },
    { argv: ["bun", "test"], cwd: path(options, "oracle") },
    { argv: ["bun", "run", "typecheck"], cwd: path(options, "bot") },
    { argv: ["bun", "test"], cwd: path(options, "bot") },
    { argv: ["bun", "run", "lint"], cwd: path(options, "timba-web-cf") },
    { argv: ["bun", "run", "build"], cwd: path(options, "timba-web-cf") },
    { argv: ["bun", "run", "test"], cwd: path(options, "timba-web-cf") },
  ];
  for (const command of commands) await run(command, options, state);
  for (const project of ["oracle", "bot", "timba-web-cf"]) {
    await run(
      {
        argv: ["git", "rev-parse", "HEAD"],
        cwd: path(options, project),
        captureAs: `${project}.commit`,
      },
      options,
      state,
    );
  }
  if (options.execute) await verifyIdls(options, state);
}

async function verifyIdls(
  options: Options,
  state: ReleaseState,
): Promise<void> {
  const files = {
    contracts: "contracts/target/idl/timba.json",
    bot: "bot/idl/idl.json",
    oracle: "oracle/idl/idl.json",
    web: "timba-web-cf/lib/solana/idl.json",
  };
  const hashes: Record<string, string> = {};
  for (const [name, relative] of Object.entries(files)) {
    const parsed = JSON.parse(
      await readFile(join(options.sourceRoot, relative), "utf8"),
    );
    const version = parsed.metadata?.version ?? parsed.version;
    if (version !== RELEASE_VERSION)
      throw new Error(`${relative} reports IDL version ${version}`);
    hashes[name] = sha256(stableJson(parsed));
  }
  if (new Set(Object.values(hashes)).size !== 1)
    throw new Error(`IDL hashes differ: ${JSON.stringify(hashes)}`);
  const canonicalHash = hashes["contracts"];
  if (!canonicalHash) throw new Error("Missing canonical contracts IDL hash");
  state.evidence["idl.sha256"] = canonicalHash;
  console.log(
    `IDL version ${RELEASE_VERSION}, canonical SHA-256 ${canonicalHash}`,
  );
}

async function drain(options: Options, state: ReleaseState): Promise<void> {
  requireApproval(
    options,
    "drain",
    "disable all game tokens and prove every legacy game on mainnet is inert",
  );
  await run(
    {
      argv: ["bun", "run", "scripts/disable-game-tokens.ts"],
      cwd: join(options.deployRoot, "bot"),
    },
    options,
    state,
  );
  await run(
    {
      argv: [
        "docker",
        "compose",
        "exec",
        "-T",
        "oracle",
        "bun",
        "run",
        "scripts/manual-shutdown.ts",
      ],
      cwd: join(options.deployRoot, "oracle"),
      captureAs: "drain.report",
    },
    options,
    state,
  );
  if (options.execute) await verifyLegacyGamesAreInert(options, state);
}

async function backup(options: Options, state: ReleaseState): Promise<void> {
  for (const project of ["bot", "oracle"]) {
    await run(
      {
        argv: ["docker", "compose", "ps", "--format", "json"],
        cwd: join(options.deployRoot, project),
        captureAs: `docker.${project}.containers.before`,
      },
      options,
      state,
    );
    await run(
      {
        argv: ["docker", "compose", "images", "--format", "json"],
        cwd: join(options.deployRoot, project),
        captureAs: `docker.${project}.images.before`,
      },
      options,
      state,
    );
    await run(
      {
        argv: ["docker", "compose", "stop"],
        cwd: join(options.deployRoot, project),
      },
      options,
      state,
    );
    const running = await run(
      {
        argv: ["docker", "compose", "ps", "-q"],
        cwd: join(options.deployRoot, project),
      },
      options,
      state,
    );
    if (options.execute && running)
      throw new Error(`${project} Docker Compose container is still running`);
  }
  const databases = [
    ["oracle", "oracle.sqlite"],
    ["bot", "chat-settings.sqlite"],
    ["bot", "games.sqlite"],
    ["bot", "tokens.sqlite"],
  ] as const;
  if (!options.execute) {
    console.log(
      `Would integrity-check and copy ${databases.length} databases to ${join(
        options.releaseDir,
        "databases",
      )}`,
    );
    return;
  }
  const destination = join(options.releaseDir, "databases");
  await mkdir(destination, { recursive: true });
  for (const [project, name] of databases) {
    const source = join(options.deployRoot, project, name);
    const integrity = await run(
      {
        argv: [
          "sqlite3",
          source,
          "PRAGMA wal_checkpoint(TRUNCATE); PRAGMA integrity_check;",
        ],
      },
      options,
      state,
    );
    if (!integrity.split("\n").includes("ok"))
      throw new Error(`${source} failed SQLite integrity check`);
    await copyFile(source, join(destination, name));
    state.evidence[`database.${name}.sha256`] = sha256(
      await readFile(join(destination, name)),
    );
  }
  state.evidence["rollback.command"] =
    "restore databases; docker compose up -d oracle; docker compose up -d bot";
}

async function build(options: Options, state: ReleaseState): Promise<void> {
  const commit = options.contractsCommit ?? state.evidence["contracts.commit"];
  if (!commit)
    throw new Error(
      "Missing frozen contracts commit; run prepare or pass --contracts-commit",
    );
  const actual = await run(
    { argv: ["git", "rev-parse", "HEAD"], cwd: path(options, "contracts") },
    options,
    state,
  );
  if (options.execute && actual !== commit)
    throw new Error(
      `Contracts HEAD ${actual} does not match frozen commit ${commit}`,
    );
  await run(
    {
      argv: ["anchor", "build", "--verifiable", "--solana-version", "3.1.10"],
      cwd: join(path(options, "contracts"), "programs/timba"),
    },
    options,
    state,
  );
  if (options.execute) {
    const binary = join(
      path(options, "contracts"),
      "target/verifiable/timba.so",
    );
    state.evidence["binary.bytes"] = String((await stat(binary)).size);
    state.evidence["binary.sha256"] = sha256(await readFile(binary));
    await run(
      {
        argv: ["solana-verify", "get-executable-hash", binary],
        captureAs: "binary.executableHash",
      },
      options,
      state,
    );
  }
}

async function deployContract(
  options: Options,
  state: ReleaseState,
): Promise<void> {
  requireApproval(
    options,
    "deploy-contract",
    `upgrade existing mainnet program ${PROGRAM_ID}; no token transfers`,
  );
  if (!options.authority)
    throw new Error("--authority or UPGRADE_AUTHORITY is required");
  await assertFileMode(options.authority);
  const authorityAddress = await run(
    {
      argv: ["solana", "address", "-k", options.authority],
      captureAs: "authority.address",
    },
    options,
    state,
  );
  await run(
    {
      argv: [
        "solana",
        "balance",
        "-k",
        options.authority,
        "--url",
        options.rpcUrl,
      ],
      captureAs: "authority.balance",
    },
    options,
    state,
  );
  const deployedBinary = join(options.releaseDir, "timba-mainnet-program.so");
  const localBinary = join(
    path(options, "contracts"),
    "target/verifiable/timba.so",
  );
  if (options.execute) await mkdir(options.releaseDir, { recursive: true });
  const programBefore = await run(
    {
      argv: ["solana", "program", "show", PROGRAM_ID, "--url", options.rpcUrl],
      captureAs: "program.before",
    },
    options,
    state,
  );
  if (options.execute && !programBefore.includes(authorityAddress))
    throw new Error(
      `Program upgrade authority does not match ${authorityAddress}`,
    );
  await run(
    {
      argv: [
        "solana",
        "program",
        "dump",
        PROGRAM_ID,
        deployedBinary,
        "--url",
        options.rpcUrl,
      ],
    },
    options,
    state,
  );
  const localExecutableHash = await run(
    { argv: ["solana-verify", "get-executable-hash", localBinary] },
    options,
    state,
  );
  const currentExecutableHash = await run(
    { argv: ["solana-verify", "get-executable-hash", deployedBinary] },
    options,
    state,
  );
  if (options.execute) {
    state.evidence["program.before.executableHash"] = currentExecutableHash;
    if (currentExecutableHash === localExecutableHash) {
      state.evidence["deployment.output"] =
        "already deployed; on-chain binary matches frozen artifact";
      return;
    }
  }
  await run(
    {
      argv: [
        "anchor",
        "deploy",
        "--verifiable",
        "--no-idl",
        "--program-name",
        "timba",
        "--provider.cluster",
        "mainnet",
        "--provider.wallet",
        options.authority,
      ],
      cwd: path(options, "contracts"),
      captureAs: "deployment.output",
    },
    options,
    state,
  );
  await run(
    {
      argv: [
        "solana",
        "program",
        "dump",
        PROGRAM_ID,
        deployedBinary,
        "--url",
        options.rpcUrl,
      ],
    },
    options,
    state,
  );
  const deployedExecutableHash = await run(
    { argv: ["solana-verify", "get-executable-hash", deployedBinary] },
    options,
    state,
  );
  if (options.execute) {
    state.evidence["program.after.executableHash"] = deployedExecutableHash;
    if (deployedExecutableHash !== localExecutableHash)
      throw new Error(
        "Deployed mainnet binary does not match the frozen artifact",
      );
  }
}

async function publishIdl(
  options: Options,
  state: ReleaseState,
): Promise<void> {
  requireApproval(
    options,
    "publish-idl",
    `create the first canonical mainnet IDL account for ${PROGRAM_ID}`,
  );
  if (!options.authority)
    throw new Error("--authority or UPGRADE_AUTHORITY is required");
  await assertFileMode(options.authority);
  const localIdl = join(path(options, "contracts"), "target/idl/timba.json");
  const fetched = join(options.releaseDir, "timba-mainnet-idl.json");
  const fetchCommand: Command = {
    argv: [
      "anchor",
      "idl",
      "fetch",
      "--provider.cluster",
      "mainnet",
      "--out",
      fetched,
      PROGRAM_ID,
    ],
    cwd: path(options, "contracts"),
  };
  if (options.execute) {
    try {
      await run(fetchCommand, options, state);
      const local = JSON.parse(await readFile(localIdl, "utf8"));
      const remote = JSON.parse(await readFile(fetched, "utf8"));
      if (stableJson(local) !== stableJson(remote))
        throw new Error(
          "A canonical IDL already exists but differs from the 0.2.0 release IDL",
        );
      state.evidence["onchain.idl.sha256"] = sha256(stableJson(remote));
      state.evidence["idl.init.output"] = "already initialized and identical";
      return;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("already exists but differs")
      )
        throw error;
      console.log("No fetchable canonical IDL found; initializing it now.");
    }
  }
  await run(
    {
      argv: [
        "anchor",
        "idl",
        "init",
        "--provider.cluster",
        "mainnet",
        "--provider.wallet",
        options.authority,
        "--filepath",
        localIdl,
        PROGRAM_ID,
      ],
      cwd: path(options, "contracts"),
      captureAs: "idl.init.output",
    },
    options,
    state,
  );
  await run(fetchCommand, options, state);
  if (options.execute) {
    const local = JSON.parse(await readFile(localIdl, "utf8"));
    const remote = JSON.parse(await readFile(fetched, "utf8"));
    if (stableJson(local) !== stableJson(remote))
      throw new Error("Published mainnet IDL differs from the release IDL");
    state.evidence["onchain.idl.sha256"] = sha256(stableJson(remote));
  }
}

async function verifySource(
  options: Options,
  state: ReleaseState,
): Promise<void> {
  requireApproval(
    options,
    "verify-source",
    `publish the reproducible source verification record for ${PROGRAM_ID}`,
  );
  const commit = options.contractsCommit ?? state.evidence["contracts.commit"];
  if (!commit) throw new Error("Missing contracts commit");
  await run(
    {
      argv: ["solana", "program", "show", PROGRAM_ID, "--url", options.rpcUrl],
      captureAs: "program.after",
    },
    options,
    state,
  );
  await run(
    {
      argv: [
        "solana-verify",
        "verify-from-repo",
        "-u",
        options.rpcUrl,
        "--program-id",
        PROGRAM_ID,
        "https://github.com/timbagame/contracts",
        "--commit-hash",
        commit,
        "--library-name",
        "timba",
        "--mount-path",
        "programs/timba",
      ],
      captureAs: "verification.output",
    },
    options,
    state,
  );
}

async function verifyRemote(
  options: Options,
  state: ReleaseState,
): Promise<void> {
  requireApproval(
    options,
    "verify-remote",
    `submit or poll reproducible verification for ${PROGRAM_ID}`,
  );
  if (!options.authority)
    throw new Error("--authority or UPGRADE_AUTHORITY is required");
  const uploader = await run(
    { argv: ["solana", "address", "-k", options.authority] },
    options,
    state,
  );
  let jobId: string | undefined =
    options.verificationJobId ?? state.evidence["verification.remote.jobId"];
  if (!jobId) {
    const submitted = await run(
      {
        argv: [
          "solana-verify",
          "remote",
          "submit-job",
          "--program-id",
          PROGRAM_ID,
          "--uploader",
          uploader,
        ],
        captureAs: "verification.remote.submit",
      },
      options,
      state,
    );
    jobId = extractVerificationJobId(submitted);
    if (options.execute && !jobId)
      throw new Error(
        "Could not parse the remote verification job ID; rerun with --verification-job-id",
      );
    if (jobId) state.evidence["verification.remote.jobId"] = jobId;
  }
  if (!jobId && !options.execute) jobId = "<JOB_ID>";
  const result = await run(
    {
      argv: ["solana-verify", "remote", "get-job", "--job-id", jobId!],
      captureAs: "verification.remote.result",
    },
    options,
    state,
  );
  if (options.execute && !remoteVerificationSucceeded(result))
    throw new Error(
      `Remote verification job ${jobId} has not succeeded; rerun verify-remote to poll it`,
    );
}

async function releaseClients(
  options: Options,
  state: ReleaseState,
): Promise<void> {
  for (const project of ["oracle", "bot", "timba-web-cf"]) {
    const testedCommit = state.evidence[`${project}.commit`];
    if (!testedCommit) throw new Error(`Missing tested ${project} commit`);
    await run(
      { argv: ["git", "fetch", "origin", "main"], cwd: path(options, project) },
      options,
      state,
    );
    await run(
      {
        argv: [
          "git",
          "merge-base",
          "--is-ancestor",
          testedCommit,
          "origin/main",
        ],
        cwd: path(options, project),
      },
      options,
      state,
    );
    await run(
      {
        argv: ["git", "rev-parse", "origin/main"],
        cwd: path(options, project),
        captureAs: `${project}.releaseCommit`,
      },
      options,
      state,
    );
  }
  console.log(
    "Confirm the oracle and bot image workflows and the web Cloudflare workflow succeeded for the recorded main commits.",
  );
}

async function migrateClients(
  options: Options,
  state: ReleaseState,
): Promise<void> {
  requireApproval(
    options,
    "migrate-clients",
    "migrate the stopped 0.1.3 Docker services to 0.2.0 Podman Quadlets in oracle, bot order",
  );
  const expectedDeployRoot = join(process.env["HOME"] ?? "", "timba");
  if (resolve(options.deployRoot) !== resolve(expectedDeployRoot))
    throw new Error(
      `Quadlet mounts require DEPLOY_ROOT=${expectedDeployRoot}; got ${options.deployRoot}`,
    );
  for (const project of ["oracle", "bot"]) {
    const dockerRunning = await run(
      {
        argv: ["docker", "compose", "ps", "-q"],
        cwd: join(options.deployRoot, project),
      },
      options,
      state,
    );
    if (options.execute && dockerRunning)
      throw new Error(
        `Refusing migration while ${project} Docker container is running`,
      );
  }
  for (const project of ["oracle", "bot"]) {
    const commit = state.evidence[`${project}.commit`];
    const releaseCommit = state.evidence[`${project}.releaseCommit`];
    if (!commit) throw new Error(`Missing tested ${project} commit`);
    if (!releaseCommit)
      throw new Error(`Missing released ${project} main commit`);
    await run(
      { argv: ["git", "switch", "main"], cwd: path(options, project) },
      options,
      state,
    );
    await run(
      {
        argv: ["git", "pull", "--ff-only", "origin", "main"],
        cwd: path(options, project),
      },
      options,
      state,
    );
    const deployedCheckout = await run(
      { argv: ["git", "rev-parse", "HEAD"], cwd: path(options, project) },
      options,
      state,
    );
    if (options.execute && deployedCheckout !== releaseCommit)
      throw new Error(
        `${project} VPS checkout ${deployedCheckout} differs from recorded release ${releaseCommit}`,
      );
    await run(
      {
        argv: ["git", "merge-base", "--is-ancestor", commit, "origin/main"],
        cwd: path(options, project),
      },
      options,
      state,
    );
  }
  for (const image of ["oracle", "bot"]) {
    await run(
      {
        argv: [
          "cosign",
          "verify",
          "--certificate-identity",
          `https://github.com/timbagame/${image}/.github/workflows/container-publish.yml@refs/heads/main`,
          "--certificate-oidc-issuer",
          "https://token.actions.githubusercontent.com",
          `ghcr.io/timbagame/${image}:main`,
        ],
      },
      options,
      state,
    );
    await run(
      { argv: ["podman", "pull", `ghcr.io/timbagame/${image}:main`] },
      options,
      state,
    );
  }
  for (const file of [
    join(options.deployRoot, "oracle/admin-keypair.json"),
    join(options.deployRoot, "oracle/secrets/oracle-api-token"),
    join(options.deployRoot, "bot/admin-keypair.json"),
    join(options.deployRoot, "bot/secrets/oracle-api-token"),
    join(options.deployRoot, "bot/secrets/bot-mnemonic"),
  ])
    if (options.execute) await assertFileMode(file);
  await run(
    {
      argv: [
        "cmp",
        "--silent",
        join(options.deployRoot, "oracle/secrets/oracle-api-token"),
        join(options.deployRoot, "bot/secrets/oracle-api-token"),
      ],
    },
    options,
    state,
  );
  const quadletDir = join(
    process.env["HOME"] ?? "",
    ".config/containers/systemd",
  );
  if (options.execute) {
    await mkdir(quadletDir, { recursive: true });
    await copyFile(
      join(path(options, "oracle"), "deploy/quadlet/timba.network"),
      join(quadletDir, "timba.network"),
    );
    await copyFile(
      join(path(options, "oracle"), "deploy/quadlet/timba-oracle.container"),
      join(quadletDir, "timba-oracle.container"),
    );
    await copyFile(
      join(path(options, "bot"), "deploy/quadlet/timba-bot.container"),
      join(quadletDir, "timba-bot.container"),
    );
  } else {
    console.log(
      `Would install the network and two Quadlet files in ${quadletDir}`,
    );
  }
  await run({ argv: ["systemctl", "--user", "daemon-reload"] }, options, state);
  await run(
    { argv: ["systemctl", "--user", "start", "timba-oracle.service"] },
    options,
    state,
  );
  await run(
    { argv: ["systemctl", "--user", "is-active", "timba-oracle.service"] },
    options,
    state,
  );
  const oracleInspect = await run(
    {
      argv: [
        "podman",
        "inspect",
        "--format",
        '{{.ImageName}} {{.ImageDigest}} {{index .Config.Labels "PODMAN_SYSTEMD_UNIT"}} {{index .Config.Labels "io.containers.autoupdate"}}',
        "oracle",
      ],
      captureAs: "podman.oracle.inspect",
    },
    options,
    state,
  );
  if (
    options.execute &&
    (!oracleInspect.includes("timba-oracle.service") ||
      !oracleInspect.endsWith("registry"))
  )
    throw new Error(
      "Oracle is not supervised by the expected auto-updating Quadlet",
    );
  await run(
    {
      argv: [
        "podman",
        "exec",
        "oracle",
        "bun",
        "-e",
        "const r=await fetch('http://127.0.0.1:3001/health'); console.log(r.status,await r.text()); if(!r.ok)process.exit(1)",
      ],
    },
    options,
    state,
  );
  await run(
    {
      argv: [
        "podman",
        "exec",
        "oracle",
        "bun",
        "-e",
        'const base="http://127.0.0.1:3001"; const denied=await fetch(base+"/stats"); if(denied.status!==401)process.exit(1); const token=(await Bun.file("/run/secrets/oracle_api_token").text()).trim(); const allowed=await fetch(base+"/stats",{headers:{Authorization:"Bearer "+token}}); console.log("oracle auth",denied.status,allowed.status); if(!allowed.ok)process.exit(1)',
      ],
      captureAs: "podman.oracle.auth",
    },
    options,
    state,
  );
  await run(
    { argv: ["systemctl", "--user", "start", "timba-bot.service"] },
    options,
    state,
  );
  await run(
    { argv: ["systemctl", "--user", "is-active", "timba-bot.service"] },
    options,
    state,
  );
  await run(
    {
      argv: [
        "podman",
        "exec",
        "bot",
        "bun",
        "-e",
        "const r=await fetch('http://127.0.0.1:3002/health'); console.log(r.status,await r.text()); if(!r.ok)process.exit(1)",
      ],
    },
    options,
    state,
  );
  const botInspect = await run(
    {
      argv: [
        "podman",
        "inspect",
        "--format",
        '{{.ImageName}} {{.ImageDigest}} {{index .Config.Labels "PODMAN_SYSTEMD_UNIT"}} {{index .Config.Labels "io.containers.autoupdate"}}',
        "bot",
      ],
      captureAs: "podman.bot.inspect",
    },
    options,
    state,
  );
  if (
    options.execute &&
    (!botInspect.includes("timba-bot.service") ||
      !botInspect.endsWith("registry"))
  )
    throw new Error(
      "Bot is not supervised by the expected auto-updating Quadlet",
    );
  for (const service of ["timba-oracle.service", "timba-bot.service"]) {
    await run(
      {
        argv: [
          "journalctl",
          "--user",
          "-u",
          service,
          "--since",
          "10 minutes ago",
          "--no-pager",
        ],
        captureAs: `podman.${service}.logs`,
      },
      options,
      state,
    );
  }
  for (const project of ["oracle", "bot"]) {
    const dockerRunning = await run(
      {
        argv: ["docker", "compose", "ps", "-q"],
        cwd: join(options.deployRoot, project),
      },
      options,
      state,
    );
    if (options.execute && dockerRunning)
      throw new Error(
        `${project} Docker service restarted during Podman migration`,
      );
  }
  console.log(
    "Confirm the Cloudflare workflow deployed the recorded web main commit before continuing.",
  );
}

async function smokeTest(options: Options, state: ReleaseState): Promise<void> {
  requireApproval(
    options,
    "smoke-test",
    "re-enable reviewed tokens and perform one controlled low-value mainnet lifecycle",
  );
  await run(
    {
      argv: ["bun", "run", "scripts/update-token-min-bets.ts"],
      cwd: join(options.deployRoot, "bot"),
    },
    options,
    state,
  );
  console.log(
    "Complete the controlled create/join/unjoin/complete checklist, then inspect all service logs before removing maintenance mode.",
  );
  state.evidence["smoke.operatorChecklist"] = "required";
}

const handlers: Record<
  Phase,
  (options: Options, state: ReleaseState) => Promise<void>
> = {
  "local-preflight": localPreflight,
  prepare,
  "vps-preflight": vpsPreflight,
  drain,
  backup,
  build,
  "deploy-contract": deployContract,
  "publish-idl": publishIdl,
  "verify-source": verifySource,
  "verify-remote": verifyRemote,
  "release-clients": releaseClients,
  "migrate-clients": migrateClients,
  "smoke-test": smokeTest,
};

async function executePhase(
  phase: Phase,
  options: Options,
  state: ReleaseState,
): Promise<void> {
  const requiredHost = PHASE_HOST[phase];
  if (options.host && options.host !== requiredHost)
    throw new Error(
      `${phase} must run on ${requiredHost}, not ${options.host}`,
    );
  if (options.execute && !options.host)
    throw new Error(`Executing ${phase} requires --host ${requiredHost}`);
  const index = PHASES.indexOf(phase);
  const previous = PHASES[index - 1];
  if (
    options.execute &&
    previous &&
    state.phases[previous]?.status !== "complete"
  ) {
    throw new Error(`${phase} requires completed phase ${previous}`);
  }
  if (!options.execute) {
    await handlers[phase](options, state);
    console.log(
      "\nDRY RUN complete; state was not advanced. Add --execute to run this phase.",
    );
    return;
  }
  state.phases[phase] = { status: "running", at: now() };
  await saveState(options, state);
  try {
    await handlers[phase](options, state);
    state.phases[phase] = { status: "complete", at: now() };
  } catch (error) {
    state.phases[phase] = { status: "failed", at: now(), error: String(error) };
    throw error;
  } finally {
    await saveState(options, state);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "import-bundle") {
    await importBundle(options);
    return;
  }
  const state = await loadState(options);
  if (
    state.version !== 2 ||
    state.programId !== PROGRAM_ID ||
    state.release !== RELEASE_VERSION
  ) {
    throw new Error("State file belongs to a different program or release");
  }
  if (options.command === "export-bundle") {
    await exportBundle(options, state);
    return;
  }
  if (options.command === "status") {
    console.log(
      JSON.stringify(
        {
          stateFile: options.stateFile,
          next: nextIncompletePhase(state),
          nextHost: nextIncompletePhase(state)
            ? PHASE_HOST[nextIncompletePhase(state)!]
            : undefined,
          ...state,
        },
        null,
        2,
      ),
    );
    return;
  }
  const phase =
    options.command === "resume" ? nextIncompletePhase(state) : options.command;
  if (!phase) {
    console.log("All phases are complete.");
    return;
  }
  console.log(
    `Timba ${RELEASE_VERSION} upgrade — ${phase} — ${
      options.execute ? "EXECUTE" : "DRY RUN"
    }`,
  );
  await executePhase(phase, options, state);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(
      `\nUpgrade stopped: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exit(1);
  });
}
