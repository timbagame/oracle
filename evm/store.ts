import { Database } from "bun:sqlite";
import { chmodSync } from "node:fs";
import type { Hex } from "viem";

export interface StoredGame {
  id: Hex;
  secret: Hex;
  intent: string;
  request: string;
  signature: Hex;
}
export interface PendingTransaction {
  game: Hex;
  raw: Hex;
  hash: Hex;
}
/** One database per deployment, also checked on open to prevent accidental cross-chain reuse. */
export class EvmStore {
  readonly db: Database;
  constructor(path: string, deployment: string) {
    this.db = new Database(path, { create: true, strict: true });
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), deployment TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS authorizations (id TEXT PRIMARY KEY, secret TEXT NOT NULL UNIQUE, intent TEXT NOT NULL, request TEXT NOT NULL, signature TEXT NOT NULL, next_check INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS pending (singleton INTEGER PRIMARY KEY CHECK(singleton=1), game TEXT NOT NULL, raw TEXT NOT NULL, hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (block INTEGER NOT NULL, hash TEXT NOT NULL, log_index INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(hash,log_index));
      CREATE TABLE IF NOT EXISTS cursor (singleton INTEGER PRIMARY KEY CHECK(singleton=1), block INTEGER NOT NULL, hash TEXT NOT NULL);`);
    this.db.query("INSERT OR IGNORE INTO identity VALUES (1, ?)").run(deployment);
    const saved = this.db
      .query<{ deployment: string }, []>("SELECT deployment FROM identity")
      .get();
    if (saved?.deployment !== deployment) {
      this.db.close();
      throw new Error("EVM database belongs to a different deployment");
    }
  }
  game(id: Hex) {
    return this.db.query<StoredGame, [string]>("SELECT * FROM authorizations WHERE id=?").get(id);
  }
  games() {
    return this.db
      .query<StoredGame, [number]>(
        "SELECT * FROM authorizations WHERE next_check <= ? ORDER BY next_check LIMIT 100",
      )
      .all(Date.now());
  }
  save(game: StoredGame) {
    this.db
      .query(
        "INSERT INTO authorizations (id,secret,intent,request,signature) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET request=excluded.request, signature=excluded.signature,intent=excluded.intent,next_check=0",
      )
      .run(game.id, game.secret, game.intent, game.request, game.signature);
  }
  defer(id: Hex, milliseconds: number) {
    this.db
      .query("UPDATE authorizations SET next_check=? WHERE id=?")
      .run(Date.now() + milliseconds, id);
  }
  pending() {
    return this.db.query<PendingTransaction, []>("SELECT game,raw,hash FROM pending").get();
  }
  submit(tx: PendingTransaction) {
    this.db.query("INSERT INTO pending VALUES (1, ?, ?, ?)").run(tx.game, tx.raw, tx.hash);
  }
  clearPending() {
    this.db.exec("DELETE FROM pending");
  }
  cursor() {
    return this.db.query<{ block: number; hash: Hex }, []>("SELECT block,hash FROM cursor").get();
  }
  resetIndex() {
    this.db.transaction(() => {
      this.db.exec(
        "DELETE FROM events; DELETE FROM cursor; UPDATE authorizations SET next_check=0",
      );
    })();
  }
  events(game?: string) {
    return this.db
      .query<{ data: string }, [string | null]>(
        "SELECT data FROM events WHERE (?1 IS NULL OR json_extract(data, '$.event.reference.gameId')=?1) ORDER BY block DESC,log_index DESC LIMIT 100",
      )
      .all(game?.toLowerCase() ?? null)
      .map((row) => JSON.parse(row.data) as unknown);
  }
  listedGameIds(offset: number, player?: string) {
    return this.db
      .query<{ id: Hex }, [string | null, number]>(
        `
      SELECT json_extract(c.data, '$.event.reference.gameId') AS id
      FROM events c WHERE json_extract(c.data, '$.event.kind')='created'
      AND ((?1 IS NULL AND json_extract(c.data, '$.event.isPrivate')=0)
        OR (?1 IS NOT NULL AND (lower(json_extract(c.data, '$.event.creator'))=?1 OR EXISTS (
          SELECT 1 FROM events j WHERE json_extract(j.data, '$.event.reference.gameId')=json_extract(c.data, '$.event.reference.gameId') AND lower(json_extract(j.data, '$.event.player'))=?1))))
      ORDER BY c.block DESC, c.log_index DESC LIMIT 21 OFFSET ?2
    `,
      )
      .all(player?.toLowerCase() ?? null, offset)
      .map((row) => row.id);
  }
  close() {
    this.db.close();
  }
}
export const json = (value: unknown): string =>
  JSON.stringify(value, (_, item: unknown) => (typeof item === "bigint" ? item.toString() : item));
