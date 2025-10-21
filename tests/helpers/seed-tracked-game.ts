import type { OracleDatabase } from "../../database.ts";
import type { OracleService } from "../../oracle-service.ts";

export type PlayerTicketSeed = {
  address: string;
  ticketIndex: number;
};

export type SeedTrackedGameOptions = {
  address: string;
  secret: string;
  randomHash: string;
  players?: PlayerTicketSeed[];
  service?: Pick<OracleService, "cleanupOldRecords">;
};

export function seedTrackedGame(
  db: OracleDatabase,
  { address, secret, randomHash, players = [], service }: SeedTrackedGameOptions,
): void {
  if (service) {
    service.cleanupOldRecords(-1);
  }

  db.saveSecretKey(address, secret, randomHash);
  db.trackGame(address);

  for (const { address: playerAddress, ticketIndex } of players) {
    db.addPlayerToGame(address, playerAddress, ticketIndex);
  }
}
