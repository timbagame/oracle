import currentIdl from "./idl/idl.json" with { type: "json" };

export type ContractVersion = "0.1.3" | "0.2.0";

export function resolveContractVersion(
  value = process.env["TIMBA_CONTRACT_VERSION"] ?? "0.1.3",
): ContractVersion {
  if (value !== "0.1.3" && value !== "0.2.0")
    throw new Error(`TIMBA_CONTRACT_VERSION must be 0.1.3 or 0.2.0; got ${value}`);
  return value;
}

type IdlRecord = any;

function instruction(idl: IdlRecord, name: string): IdlRecord {
  const value = idl.instructions.find((item: IdlRecord) => item.name === name);
  if (!value) throw new Error(`IDL instruction ${name} is missing`);
  return value;
}

function findAccount(accounts: IdlRecord[], name: string): IdlRecord | undefined {
  for (const value of accounts) {
    if (value.name === name) return value;
    const nested = value.accounts ? findAccount(value.accounts, name) : undefined;
    if (nested) return nested;
  }
  return undefined;
}

function account(accounts: IdlRecord[], name: string): IdlRecord {
  const value = findAccount(accounts, name);
  if (value) return value;
  throw new Error(`IDL account ${name} is missing`);
}

function addSystemProgram(idl: IdlRecord, instructionName: string): void {
  instruction(idl, instructionName).accounts.push({
    name: "system_program",
    address: "11111111111111111111111111111111",
  });
}

export function createLegacyIdl(source: IdlRecord = currentIdl): IdlRecord {
  const idl = structuredClone(source);
  idl.metadata.version = "0.1.3";

  for (const name of [
    "close_game",
    "complete_game",
    "join_game",
    "unjoin_game",
    "withdraw_token_fee",
  ])
    addSystemProgram(idl, name);

  account(instruction(idl, "complete_game").accounts, "winner").writable = true;
  const initializeGame = instruction(idl, "initialize_game");
  initializeGame.accounts = initializeGame.accounts.filter(
    (value: IdlRecord) => value.name !== "oracle_operator",
  );
  account(initializeGame.accounts, "oracle").writable = true;

  const initializeOracle = instruction(idl, "initialize_oracle");
  initializeOracle.accounts = initializeOracle.accounts.filter(
    (value: IdlRecord) => !["upgrade_authority", "program", "program_data"].includes(value.name),
  );
  account(instruction(idl, "unjoin_game").accounts, "player").writable = true;
  account(instruction(idl, "withdraw_token_fee").accounts, "oracle").writable = true;

  const game = idl.types.find((value: IdlRecord) => value.name === "Game");
  const participants = game.type.fields.find((value: IdlRecord) => value.name === "participants");
  participants.name = "participant_hashes";
  participants.docs = [
    'Exact participant hash list (first 8 bytes of SHA256("timba:part:v1" || game_key || pubkey))',
  ];
  participants.type = { vec: "u64" };

  const unjoined = idl.types.find((value: IdlRecord) => value.name === "PlayerUnjoined");
  unjoined.type.fields = unjoined.type.fields.filter(
    (value: IdlRecord) => value.name !== "moved_participant",
  );
  idl.errors = idl.errors
    .filter((value: IdlRecord) => ![7207, 7208, 7209, 7304, 7405].includes(value.code))
    .map((value: IdlRecord) =>
      value.code >= 7104 && value.code <= 7107
        ? { ...value, code: value.code + 2 }
        : value.code === 7204
          ? {
              ...value,
              name: "WinnerPubkeyHashMismatch",
              msg: "Winner hash mismatch",
            }
          : value,
    );
  idl.errors.push(
    { code: 7104, name: "GameNotCompleted", msg: "Game incomplete" },
    { code: 7105, name: "InvalidGameType", msg: "Invalid game type" },
    { code: 7304, name: "InvalidConfiguration", msg: "Bad configuration" },
    { code: 7305, name: "OracleBufferTooSmall", msg: "Oracle buffer short" },
  );
  idl.errors.sort((left: IdlRecord, right: IdlRecord) => left.code - right.code);
  return idl;
}

export const contractVersion = resolveContractVersion();
export const contractIdl = contractVersion === "0.1.3" ? createLegacyIdl() : currentIdl;
