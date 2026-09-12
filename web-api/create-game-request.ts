import { address, type Address } from "@solana/kit";
import type { TimbaGameType } from "./types.ts";

export interface CreateGameRequest {
  creator?: string;
  tokenMint?: string;
  type?: TimbaGameType;
  amount?: string;
  minPlayers?: number;
  maxPlayers?: number;
  timeoutSeconds?: number;
}

export class CreateGameValidationError extends Error {
  constructor(readonly publicMessage: string) {
    super(publicMessage);
    this.name = "CreateGameValidationError";
  }
}

function invalid(message: string): never {
  throw new CreateGameValidationError(message);
}

export function validateCreateGameRequest(body: CreateGameRequest) {
  let creator: Address;
  let tokenMint: Address;
  try {
    creator = address(body.creator || "");
    tokenMint = address(body.tokenMint || "");
  } catch {
    invalid("Invalid creator or token address");
  }
  if (body.type !== "coinflip" && body.type !== "giveaway") invalid("Invalid game type");
  if (!body.amount || !/^\d{1,20}$/.test(body.amount)) invalid("Invalid amount");
  const amount = BigInt(body.amount);
  if (amount <= 0n) invalid("Amount must be positive");
  if (amount > 18_446_744_073_709_551_615n) invalid("Amount is too large");

  const minPlayers = body.minPlayers ?? 0;
  const maxPlayers = body.maxPlayers ?? 0;
  const minimumPlayers = body.type === "coinflip" ? 2 : 1;
  if (!Number.isInteger(minPlayers) || !Number.isInteger(maxPlayers))
    invalid("Player limits must be whole numbers");
  if (minPlayers < minimumPlayers || maxPlayers < minPlayers || maxPlayers > 100)
    invalid("Player limits are invalid");

  const timeoutSeconds = body.timeoutSeconds ?? 0;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 60 || timeoutSeconds > 86_400)
    invalid("Timeout must be between 1 minute and 24 hours");

  return { creator, tokenMint, type: body.type, amount, minPlayers, maxPlayers, timeoutSeconds };
}
