import * as anchor from "@coral-xyz/anchor";
import { randomBytes, createHash } from 'crypto';
import { OracleDatabase } from "./database.ts";
import type { Coinflip } from "./idl/idlType.ts";
import idl from "./idl/idl.json" with { type: "json" };
import * as fs from "fs";
import * as path from "path";

// Constants
const KEYPAIR_FILE = "admin-keypair.json";
const SECRET_KEY_LENGTH = 32;
const MAX_COMPLETION_ATTEMPTS = 5;
const DEFAULT_DELAY_MS = 1000;


// Event handling types
type EventHandler = (event: any) => Promise<void> | void;
type EventMap = {
  gameInitialized: any;
  playerJoined: any;
  playerUnjoined: any;
  gameCompleted: any;
  gameClosed: any;
  oracleInitialized: any;
  oracleUpdated: any;

  tokenFeeWithdrawn: any;
  tokenInitialized: any;
  tokenUpdated: any;
};

// Types
interface GameCompletionResult {
  success: boolean;
  notReady?: boolean;
  error?: string;
  txHash?: string;
}

interface GameSecrets {
  randomHash: string;
  gameAddress: string;
}

interface CompletionStats {
  completed: number;
  errors: number;
  notReady: number;
}

export class OracleService {
  private static instance: OracleService;
  private program: anchor.Program<Coinflip>;
  private connection: anchor.web3.Connection;
  private adminKeypair: anchor.web3.Keypair;
  private db: OracleDatabase;
  private eventListeners: number[] = [];
  private isListening: boolean = false;

  private constructor(db?: OracleDatabase) {
    this.db = db ?? OracleDatabase.getInstance();
    this.connection = this.initializeConnection();
    this.adminKeypair = this.loadAdminKeypair();
    this.program = this.initializeProgram();
  }

  public static getInstance(): OracleService {
    if (!OracleService.instance) {
      OracleService.instance = new OracleService();
    }
    return OracleService.instance;
  }

  // Factory for tests or custom wiring: does not affect the singleton
  public static createWith(db: OracleDatabase): OracleService {
    return new OracleService(db);
  }

  private initializeConnection(): anchor.web3.Connection {
    const networkUrl = process.env["SOLANA_NETWORK"];
    if (!networkUrl) {
      throw new Error("SOLANA_NETWORK environment variable is required");
    }
    return new anchor.web3.Connection(networkUrl, "confirmed");
  }

  private loadAdminKeypair(): anchor.web3.Keypair {
    const configured = process.env["ORACLE_KEYPAIR_PATH"];
    const filename = configured && configured.trim().length > 0 ? configured : KEYPAIR_FILE;
    const keypairPath = path.isAbsolute(filename) ? filename : path.join(process.cwd(), filename);
    try {
      const keypairData = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
      const keypair = anchor.web3.Keypair.fromSecretKey(new Uint8Array(keypairData));
      console.log(`✅ Loaded admin keypair: ${keypair.publicKey.toBase58()}`);
      return keypair;
    } catch (error: any) {
      console.error(`❌ Failed to load admin keypair from ${keypairPath}:`, error?.message || error);
      throw new Error(`Failed to load admin keypair from ${filename}`);
    }
  }

  private initializeProgram(): anchor.Program<Coinflip> {
    const adminWallet = new anchor.Wallet(this.adminKeypair);
    const provider = new anchor.AnchorProvider(
      this.connection,
      adminWallet,
      { commitment: "confirmed" }
    );
    anchor.setProvider(provider);
    return new anchor.Program(idl as Coinflip, provider) as anchor.Program<Coinflip>;
  }

  public async startEventListening(): Promise<void> {
    if (this.isListening) return;

    console.log("🎧 Starting event listeners...");
    try {
      const listeners = await this.setupEventListeners();
      this.eventListeners.push(...listeners);
      this.isListening = true;
    } catch (error) {
      console.error("❌ Failed to start event listeners:", error);
      throw error;
    }
  }

  private async setupEventListeners(): Promise<number[]> {
    const eventMap: Array<[keyof EventMap, EventHandler]> = [
      ['playerJoined', this.handlePlayerEvent.bind(this, 'joined')],
      ['playerUnjoined', this.handlePlayerEvent.bind(this, 'unjoined')],
      ['gameInitialized', this.handleGameInitialized.bind(this)],
      ['gameCompleted', this.handleGameStatusChange.bind(this, 'completed')],
      ['gameClosed', this.handleGameStatusChange.bind(this, 'closed')]
    ];

    return eventMap.map(([eventName, handler]) =>
      this.program.addEventListener(eventName, handler)
    );
  }

  public async stopEventListening(): Promise<void> {
    if (!this.isListening) return;

    await Promise.allSettled(
      this.eventListeners.map(listenerId => this.program.removeEventListener(listenerId))
    );
    this.eventListeners = [];
    this.isListening = false;
  }

  private async handlePlayerEvent(action: 'joined' | 'unjoined', event: any): Promise<void> {
    const { gameAddress, playerAddress, ticketIndex } = this.extractEventData(event);

    try {
      if (!gameAddress) {
        console.warn(`⚠️  Missing game address in ${action} event`);
        return;
      }

      if (ticketIndex === undefined) {
        console.warn(`⚠️  Missing ticket index in ${action} event for ${gameAddress}`);
        return;
      }

      // Handle player database operations
      switch (action) {
        case 'joined':
          if (!playerAddress) {
            console.warn(`⚠️  Missing player address in join event for ${gameAddress}`);
            return;
          }
          this.db.addPlayerToGame(gameAddress, playerAddress, ticketIndex);
          break;
        case 'unjoined':
          this.db.removePlayerFromGame(gameAddress, ticketIndex);
          break;

      }

      // Check for auto-completion after player events
      await this.tryAutoComplete(event.gameKey, gameAddress, action);
    } catch (error) {
      console.error(`❌ Error in player ${action} event:`, error);
    }
  }

  private handleGameStatusChange(status: 'completed' | 'closed', event: any): void {
    const { gameAddress } = this.extractEventData(event);

    try {
      if (status === 'completed') {
        this.db.markGameCompleted(gameAddress);
      } else {
        this.db.markGameClosed(gameAddress);
        this.db.clearStalePlayersForGame(gameAddress);
        console.log(`🚫 Game closed: ${gameAddress}`);
      }
    } catch (error) {
      console.error(`❌ Error in game ${status} event:`, error);
    }
  }

  private handleGameInitialized(event: any): void {
    const { gameAddress } = this.extractEventData(event);

    // Extract game type from event
    let gameType: string | undefined = undefined;
    if (event.gameType) {
      // GameType is an enum, extract the variant name
      const gameTypeKeys = Object.keys(event.gameType);
      if (gameTypeKeys.length > 0 && gameTypeKeys[0]) {
        gameType = gameTypeKeys[0].toLowerCase();
      }
    }

    console.log(`🎮 Game initialized: ${gameAddress}, Type: ${gameType || 'unknown'}`);
    this.db.trackGame(gameAddress, gameType);
  }


  private extractEventData(event: any): {
    gameAddress: string;
    playerAddress?: string;
    ticketIndex?: number;
  } {
    const gameKey = event.gameKey;
    const playerKey = event.player;

    const resolvePubkey = (key: any): string | undefined => {
      if (!key) return undefined;
      if (typeof key === "string") return key;
      if (key instanceof anchor.web3.PublicKey) return key.toBase58();
      if (typeof key.toBase58 === "function") return key.toBase58();
      if (typeof key.toString === "function") return key.toString();
      return undefined;
    };

    const resolveIndex = (value: any): number | undefined => {
      if (value === undefined || value === null) return undefined;
      if (typeof value === "number") return value;
      if (typeof value === "bigint") return Number(value);
      if (typeof value.toNumber === "function") return value.toNumber();
      if (typeof value.valueOf === "function") {
        const raw = value.valueOf();
        if (typeof raw === "number") return raw;
      }
      return undefined;
    };

    return {
      gameAddress: resolvePubkey(gameKey) ?? "",
      playerAddress: resolvePubkey(playerKey),
      ticketIndex: resolveIndex(event.ticketIndex ?? event.ticket_index),
    };
  }

  private async tryAutoComplete(gamePda: anchor.web3.PublicKey, gameAddress: string, trigger: string): Promise<void> {
    if (await this.isGameReadyForCompletion(gamePda)) {
      console.log(`🎯 Auto-completing game ${gameAddress} after ${trigger}`);
      const result = await this.completeGame(gameAddress);
      if (!result.success && !result.notReady) {
        console.error(`❌ Auto-completion failed: ${result.error}`);
      }
    }
  }

  public generateGameSecrets(): GameSecrets {
    const secretKey = randomBytes(SECRET_KEY_LENGTH);
    const randomHash = createHash('sha256').update(secretKey).digest();
    const gamePda = this.getGamePDA(randomHash);
    const gameAddress = gamePda.toBase58();

    // Store in database
    this.db.saveSecretKey(gameAddress, secretKey.toString('hex'), randomHash.toString('hex'));
    this.db.trackGame(gameAddress);

    const secrets: GameSecrets = {
      randomHash: randomHash.toString('hex'),
      gameAddress
    };


    return secrets;
  }

  public async isGameReadyForCompletion(gamePda: anchor.web3.PublicKey): Promise<boolean> {
    try {
      const gameAccount = await this.program.account.game.fetch(gamePda);
      const blockTime = await this.getBlockchainTime();

      const expiresAt = Number(gameAccount.createdAt) + Number(gameAccount.timeout);
      const isExpired = blockTime > expiresAt;
      const isFull = gameAccount.ticketsCount >= gameAccount.maxTickets;
      const hasMinTickets = gameAccount.ticketsCount >= gameAccount.minTickets;

      return isFull || (isExpired && hasMinTickets);
    } catch (error: any) {
      if (this.isAccountNotFoundError(error)) {
        const gameAddress = gamePda.toBase58();
        this.db.markGameCompleted(gameAddress);
        return false;
      }
      throw error;
    }
  }

  public async completeGame(gameAddress: string): Promise<GameCompletionResult> {
    try {
      const secretData = this.db.getSecretKey(gameAddress);
      if (!secretData) {
        return { success: false, error: "No secret key found" };
      }

      const gamePda = this.getGamePDAFromAddress(gameAddress);
      if (!(await this.isGameReadyForCompletion(gamePda))) {
        return { success: false, notReady: true };
      }

      const gameAccount = await this.program.account.game.fetch(gamePda);
      const players = this.db.getGamePlayers(gameAddress);
      const nEntries = Number(gameAccount.ticketsCount);

      if (players.length === 0) {
        return { success: false, error: "No players found for game" };
      }

      if (players.length !== nEntries) {
        console.error(
          `❌ Ticket registry mismatch for ${gameAddress}: expected ${nEntries}, found ${players.length}`
        );
        return { success: false, error: "Ticket registry out of sync" };
      }

      const secretKeyBuffer = Buffer.from(secretData.secretKey, "hex");
      const randomHashBuffer = Buffer.from(secretData.randomHash, "hex");
      const winnerIndex = this.calculateWinnerIndex(
        secretKeyBuffer,
        Number(gameAccount.lastSlot),
        nEntries
      );
      const winnerPlayerAddress = players[winnerIndex];

      if (!winnerPlayerAddress) {
        return { success: false, error: "Unable to determine winner" };
      }

      const winnerAddress = new anchor.web3.PublicKey(winnerPlayerAddress);

      const txHash = await this.executeGameCompletion({
        gamePda,
        gameAccount,
        winnerAddress,
        randomHashBuffer,
        secretKeyBuffer,
        winnerIndex,
      });

      this.db.markSecretKeyUsed(gameAddress);
      this.db.markGameCompleted(gameAddress);

      return { success: true, txHash };
    } catch (error: any) {
      this.db.incrementCompletionAttempts(gameAddress);
      return { success: false, error: error.message };
    }
  }

  private async executeGameCompletion(args: {
    gamePda: anchor.web3.PublicKey;
    gameAccount: any;
    winnerAddress: anchor.web3.PublicKey;
    randomHashBuffer: Buffer;
    secretKeyBuffer: Buffer;
    winnerIndex: number;
  }): Promise<string> {
  const { gameAccount, winnerAddress, randomHashBuffer, secretKeyBuffer, winnerIndex } = args;

  const txHash = await this.program.methods
      .completeGame([...randomHashBuffer], [...secretKeyBuffer], winnerIndex)
  .accounts({ oracleOperator: this.adminKeypair.publicKey, winner: winnerAddress, creator: gameAccount.creator as anchor.web3.PublicKey })
      .signers([this.adminKeypair])
      .rpc();

    await this.confirmTransaction(txHash);
    return txHash;
  }

  private calculateWinnerIndex(
    secretKeyBuffer: Buffer,
    lastSlot: number,
    nPlayers: number
  ): number {
    if (nPlayers <= 1) return 0;

    const lastSlotBytes = Buffer.alloc(8);
    lastSlotBytes.writeBigUInt64LE(BigInt(lastSlot));

    const combinedData = Buffer.concat([
      secretKeyBuffer.subarray(0, 32),
      lastSlotBytes,
    ]);

    const entropyHash = createHash("sha256").update(combinedData).digest();

    const maxU64 = 0xffff_ffff_ffff_ffffn;
    const nPlayersBig = BigInt(nPlayers);
    const maxValid = maxU64 - (maxU64 % nPlayersBig);

    for (let startPos = 0; startPos <= entropyHash.length - 8; startPos++) {
      const randomU64 = entropyHash.readBigUInt64LE(startPos);
      if (randomU64 < maxValid) {
        return Number(randomU64 % nPlayersBig);
      }
    }

    throw new Error(
      "Unable to generate unbiased random number - game must be cancelled"
    );
  }

  private async getBlockchainTime(): Promise<number> {
    try {
      const slot = await this.connection.getSlot();
      const blockTime = await this.connection.getBlockTime(slot);
      return blockTime || Math.floor(Date.now() / 1000);
    } catch {
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

  private isAccountNotFoundError(error: any): boolean {
    return error.message?.includes('Account does not exist');
  }

  private async delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  public cleanupOldRecords(hoursOld: number = 48) {
    return this.db.cleanupOldRecords(hoursOld);
  }



  public getStats() {
    return {
      ...this.db.getStats(),
      eventListening: this.isListening,
      activeListeners: this.eventListeners.length
    };
  }

  public async scanAndCompleteActiveGames(): Promise<CompletionStats> {
    const stats: CompletionStats = { completed: 0, errors: 0, notReady: 0 };
    const pendingGames = this.db.getPendingGames();

    if (pendingGames.length === 0) return stats;

    console.log(`🔍 Scanning ${pendingGames.length} pending games...`);

    for (const game of pendingGames) {
      if (game.completion_attempts >= MAX_COMPLETION_ATTEMPTS) {
        console.log(`⏭️  Skipping game ${game.game_address} (${game.completion_attempts} attempts)`);
        continue;
      }

      try {
        // Check if game still exists on-chain
        if (!(await this.gameExistsOnChain(game.game_address))) {
          this.db.markGameCompleted(game.game_address);
          continue;
        }

        const result = await this.completeGame(game.game_address);
        this.updateScanStats(stats, result);

        await this.delay(DEFAULT_DELAY_MS);
      } catch (error) {
        stats.errors++;
        console.error(`❌ Error completing game ${game.game_address}:`, error);
      }
    }

    this.logScanResults(stats);
    return stats;
  }

  private async gameExistsOnChain(gameAddress: string): Promise<boolean> {
    try {
      const secretData = this.db.getSecretKey(gameAddress);
      if (!secretData) {
        console.log(`⚠️  No secret key found for game ${gameAddress}`);
        return false;
      }

      const gamePda = this.getGamePDAFromAddress(gameAddress);
      await this.program.account.game.fetch(gamePda);
      return true;
    } catch (error: any) {
      if (this.isAccountNotFoundError(error)) {
        console.log(`⚠️  Game ${gameAddress} no longer exists on-chain`);
        return false;
      }
      throw error;
    }
  }

  private updateScanStats(stats: CompletionStats, result: GameCompletionResult): void {
    if (result.success) {
      stats.completed++;
    } else if (result.notReady) {
      stats.notReady++;
    } else {
      stats.errors++;
    }
  }

  private logScanResults(stats: CompletionStats): void {
    if (stats.completed > 0 || stats.errors > 0 || stats.notReady > 0) {
      const parts = [];
      if (stats.completed > 0) parts.push(`${stats.completed} completed`);
      if (stats.errors > 0) parts.push(`${stats.errors} errors`);
      if (stats.notReady > 0) parts.push(`${stats.notReady} not ready`);

      console.log(`📊 Scan: ${parts.join(', ')}`);
    }
  }

  private getGamePDA(randomHash: Buffer): anchor.web3.PublicKey {
    const [pda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("game", 'utf8'), randomHash],
      this.program.programId
    );
    return pda;
  }

  private getGamePDAFromAddress(gameAddress: string): anchor.web3.PublicKey {
    // Since we can predict PDAs now, we can reverse engineer from the stored secret
    const secretData = this.db.getSecretKey(gameAddress);
    if (!secretData) {
      throw new Error(`No secret data found for game ${gameAddress}`);
    }
    const randomHash = Buffer.from(secretData.randomHash, "hex");
    return this.getGamePDA(randomHash);
  }

}
