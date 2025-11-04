import { describe, it, expect } from "bun:test";
import type * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { PlayerRegistrySync } from "../player-registry-sync.ts";

type EventData = {
  name: string;
  data: Record<string, unknown>;
};

function createSync(eventsPerTransaction: Array<EventData[]>): PlayerRegistrySync {
  const programId = Keypair.generate().publicKey;
  const program = {
    programId,
    coder: {},
    idl: {},
  } as const;

  const signatures = [{ signature: "sig-1" }] as Array<anchor.web3.ConfirmedSignatureInfo>;
  let signatureCalls = 0;
  let parseIndex = 0;

  const connection = {
    async getSignaturesForAddress(_address: PublicKey) {
      return signatureCalls++ === 0 ? signatures : [];
    },
    async getTransaction(_signature: string) {
      return { meta: { logMessages: ["dummy"] } } as const;
    },
  } as unknown as anchor.web3.Connection;

  return new PlayerRegistrySync({
    connection,
    program: program as unknown as anchor.Program<any>,
    eventParserFactory: () => ({
      parseLogs: () => eventsPerTransaction[parseIndex++] ?? [],
    }),
  });
}

describe("PlayerRegistrySync", () => {
  it("recovers players when ticket indexes start at one", async () => {
    const gamePda = Keypair.generate().publicKey;
    const playerOne = Keypair.generate().publicKey;
    const playerTwo = Keypair.generate().publicKey;

    const events: EventData[] = [
      {
        name: "playerJoined",
        data: {
          gameKey: gamePda,
          player: playerOne,
          ticketIndex: 1,
        },
      },
      {
        name: "playerJoined",
        data: {
          gameKey: gamePda,
          player: playerTwo,
          ticketIndex: 2,
        },
      },
    ];

    const sync = createSync([events]);

    const players = await sync.fetchPlayersFromChain({
      gamePda,
      expectedTickets: 2,
    });

    expect(players).toEqual([
      playerOne.toBase58(),
      playerTwo.toBase58(),
    ]);
  });

  it("rejects registries with index gaps", async () => {
    const gamePda = Keypair.generate().publicKey;
    const playerOne = Keypair.generate().publicKey;
    const playerTwo = Keypair.generate().publicKey;

    const events: EventData[] = [
      {
        name: "playerJoined",
        data: {
          gameKey: gamePda,
          player: playerOne,
          ticketIndex: 1,
        },
      },
      {
        name: "playerJoined",
        data: {
          gameKey: gamePda,
          player: playerTwo,
          ticketIndex: 3,
        },
      },
    ];

    const sync = createSync([events]);

    const players = await sync.fetchPlayersFromChain({
      gamePda,
      expectedTickets: 2,
    });

    expect(players).toBeNull();
  });
});
