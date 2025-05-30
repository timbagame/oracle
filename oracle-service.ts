import { PublicKey, Connection, Keypair } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { randomBytes, createHash } from 'crypto';
import { OracleDatabase } from "./database.ts";
import type { Coinflip } from "./idl/idlType.ts";
import idl from "./idl/idl.json" with { type: "json" };
import * as fs from "fs";
import * as path from "path";

interface GameCompletionResult {
  success: boolean;
  error?: string;
  txHash?: string;
}

export class OracleService {
  private static instance: OracleService;
  private program: anchor.Program<Coinflip>;
  private connection: Connection;
  private adminKeypair: Keypair;
  private db: OracleDatabase;

  private constructor() {
    this.db = OracleDatabase.getInstance();
    this.connection = new Connection(process.env["SOLANA_NETWORK"]!, "confirmed");
    this.adminKeypair = this.loadAdminKeypair();
    this.program = this.initializeProgram();
  }

  public static getInstance(): OracleService {
    if (!OracleService.instance) {
      OracleService.instance = new OracleService();
    }
    return OracleService.instance;
  }

  private loadAdminKeypair(): Keypair {
    try {
      const keypairPath = path.join(process.cwd(), "admin-keypair.json");
      const keypairData = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
      const keypair = Keypair.fromSecretKey(new Uint8Array(keypairData));
      console.log(`Loaded admin keypair: ${keypair.publicKey.toBase58()}`);
      return keypair;
    } catch (error) {
      console.error("Failed to load admin keypair:", error);
      throw error;
    }
  }

  private initializeProgram(): anchor.Program<Coinflip> {
    const adminWallet = new anchor.Wallet(this.adminKeypair);
    const provider = new anchor.AnchorProvider(this.connection, adminWallet, { commitment: "confirmed" });
    anchor.setProvider(provider);
    return new anchor.Program(idl as Coinflip, provider) as anchor.Program<Coinflip>;
  }

  public generateGameSecrets(): { randomHash: string; gameAddress: string } {
    const secretKey = randomBytes(64);
    const randomHash = createHash('sha256').update(secretKey).digest();
    const gamePda = this.getGamePDA(randomHash);

    this.db.saveSecretKey(
      gamePda.toBase58(),
      secretKey.toString('hex'),
      randomHash.toString('hex')
    );
    this.db.trackGame(gamePda.toBase58());

    console.log(`Generated secrets for game: ${gamePda.toBase58()}`);
    return {
      randomHash: randomHash.toString('hex'),
      gameAddress: gamePda.toBase58()
    };
  }

  public async isGameReadyForCompletion(gamePda: PublicKey): Promise<boolean> {
    try {
      const gameAccount = await this.program.account.game.fetch(gamePda);
      const blockTime = await this.getBlockchainTime();

      const createdAt = Number(gameAccount.createdAt);
      const timeout = Number(gameAccount.timeout);
      const expiresAt = createdAt + timeout;
      const isExpired = blockTime > expiresAt;

      return gameAccount.players.length >= gameAccount.maxPlayers ||
        (isExpired && gameAccount.players.length >= gameAccount.minPlayers);
    } catch (error: any) {
      if (error.message?.includes('Account does not exist')) {
        console.log(`Game ${gamePda.toBase58()} completed or closed`);
        this.db.markGameCompleted(gamePda.toBase58());
        return false;
      }
      throw error;
    }
  }

  public async completeGame(gameAddress: string): Promise<GameCompletionResult> {
    try {
      const gamePda = new PublicKey(gameAddress);

      const secretData = this.db.getSecretKey(gameAddress);
      if (!secretData) {
        return { success: false, error: "No secret key found for game" };
      }

      const isReady = await this.isGameReadyForCompletion(gamePda);
      if (!isReady) {
        return { success: false, error: "Game is not ready for completion" };
      }

      const gameAccount = await this.program.account.game.fetch(gamePda);
      const secretKeyBuffer = Buffer.from(secretData.secretKey, "hex");
      const winnerIndex = this.calculateWinnerIndex(secretKeyBuffer, gameAccount.players.length);
      const winnerAddress = gameAccount.players[winnerIndex];

      if (!winnerAddress) {
        return { success: false, error: "Unable to determine winner" };
      }

      console.log(`Completing game ${gameAddress}, winner: ${winnerAddress.toBase58()}`);

      const tx = await this.program.methods
        .completeGame([...secretKeyBuffer])
        .accounts({
          game: gamePda,
          player: winnerAddress,
          creator: gameAccount.creator,
          authority: this.adminKeypair.publicKey,
        })
        .signers([this.adminKeypair])
        .rpc();

      await this.confirmTransaction(tx);

      this.db.markSecretKeyUsed(gameAddress);
      this.db.markGameCompleted(gameAddress);

      console.log(`✅ Successfully completed game ${gameAddress}, tx: ${tx}`);
      return { success: true, txHash: tx };

    } catch (error: any) {
      console.error(`❌ Error completing game ${gameAddress}:`, error);
      this.db.incrementCompletionAttempts(gameAddress);
      return { success: false, error: error.message };
    }
  }

  public async scanAndCompleteActiveGames(): Promise<{ completed: number; errors: number }> {
    console.log('🔍 Scanning for active games...');

    let completed = 0;
    let errors = 0;

    try {
      const pendingGames = this.db.getPendingGames();
      console.log(`Found ${pendingGames.length} pending games`);

      for (const pendingGame of pendingGames) {
        // Skip games that have failed too many times
        if (pendingGame.completion_attempts > 5) {
          continue;
        }

        try {
          const result = await this.completeGame(pendingGame.game_address);
          if (result.success) {
            completed++;
          } else {
            errors++;
          }

          // Small delay between operations
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
          errors++;
          console.error(`Error processing game ${pendingGame.game_address}:`, error);
        }
      }

      console.log(`Scan complete: ${completed} completed, ${errors} errors`);
      return { completed, errors };

    } catch (error) {
      console.error('Error in scan process:', error);
      return { completed, errors: errors + 1 };
    }
  }

  private getGamePDA(randomHash: Buffer): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("game", 'utf8'), randomHash],
      this.program.programId
    );
    return pda;
  }

  private calculateWinnerIndex(secretKeyBuffer: Buffer, nPlayers: number): number {
    if (nPlayers <= 1) return 0;

    const randomBytes = secretKeyBuffer.subarray(0, 8);
    const randomNumber = BigInt('0x' + Buffer.from(randomBytes).reverse().toString('hex'));
    const maxValid = BigInt('0xFFFFFFFFFFFFFFFF') - (BigInt('0xFFFFFFFFFFFFFFFF') % BigInt(nPlayers));
    const finalNumber = randomNumber % maxValid;
    return Number(finalNumber % BigInt(nPlayers));
  }

  private async getBlockchainTime(): Promise<number> {
    try {
      const slot = await this.connection.getSlot();
      const blockTime = await this.connection.getBlockTime(slot);
      return blockTime || Math.floor(Date.now() / 1000);
    } catch (error) {
      return Math.floor(Date.now() / 1000);
    }
  }

  private async confirmTransaction(signature: string): Promise<void> {
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();
    await this.connection.confirmTransaction({
      signature,
      blockhash,
      lastValidBlockHeight
    });
  }

  public getStats() {
    return this.db.getStats();
  }
}
