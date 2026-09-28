import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IndexerDatabase } from "../indexer/database.ts";
import { main } from "../scripts/import-indexer.ts";
import { captureConsole, createRestorer } from "./helpers/cli.ts";

const restorer = createRestorer();
afterEach(() => restorer.restoreAll());

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "timba-import-indexer-"));
  restorer.add(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** Runs the import script with `args` and returns what it printed. */
async function runImport(args: string[]) {
  const output = captureConsole(restorer);
  await main(args);
  return output;
}

test("imports a D1 export into a new indexer database", async () => {
  const directory = tempDirectory();
  const source = join(directory, "export.sql");
  const target = join(directory, "indexer.sqlite");
  writeFileSync(
    source,
    "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT);\n" +
      "INSERT INTO d1_migrations VALUES (1, '0001_init.sql');\n",
  );
  const output = await runImport([source, target]);

  expect(output.log).toEqual([`Imported D1 history into ${target}`]);
  expect(readdirSync(directory).sort()).toEqual(["export.sql", "indexer.sqlite"]);
  const imported = new Database(target, { readonly: true });
  expect(imported.query("SELECT name FROM d1_migrations").all()).toEqual([
    { name: "0001_init.sql" },
  ]);
  imported.close();
  const indexer = new IndexerDatabase(target);
  expect(indexer.getBackfillState().complete).toBe(false);
  indexer.close();
  expect(existsSync(`${target}.importing-${process.pid}`)).toBe(false);
});

test("requires a D1 export path", async () => {
  await expect(runImport([])).rejects.toThrow(
    "Usage: bun run indexer:import <d1-export.sql> [indexer.sqlite]",
  );
});

test("rejects a D1 export that does not exist", async () => {
  const directory = tempDirectory();
  const source = join(directory, "missing.sql");

  await expect(runImport([source, join(directory, "indexer.sqlite")])).rejects.toThrow(
    `D1 export not found: ${source}`,
  );
  expect(readdirSync(directory)).toEqual([]);
});

test("refuses to overwrite an existing indexer database", async () => {
  const directory = tempDirectory();
  const source = join(directory, "export.sql");
  const target = join(directory, "indexer.sqlite");
  writeFileSync(source, "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT);\n");
  writeFileSync(target, "existing");

  await expect(runImport([source, target])).rejects.toThrow(
    `Refusing to overwrite existing indexer database: ${target}`,
  );
  expect(await Bun.file(target).text()).toBe("existing");
});

test("removes the partial database when the export cannot be applied", async () => {
  const directory = tempDirectory();
  const source = join(directory, "export.sql");
  writeFileSync(source, "THIS IS NOT SQL;\n");

  await expect(runImport([source, join(directory, "indexer.sqlite")])).rejects.toThrow(
    "syntax error",
  );
  expect(readdirSync(directory)).toEqual(["export.sql"]);
});

test("rejects an export whose historical backfill is incomplete", async () => {
  const directory = tempDirectory();
  const source = join(directory, "export.sql");
  const target = join(directory, "indexer.sqlite");
  writeFileSync(
    source,
    "CREATE TABLE games (signature TEXT PRIMARY KEY, game_key TEXT NOT NULL, winner TEXT NOT NULL," +
      " winner_amount INTEGER NOT NULL, fee_amount INTEGER NOT NULL, tickets_count INTEGER NOT NULL," +
      " token_mint TEXT NOT NULL, timestamp INTEGER NOT NULL, slot INTEGER NOT NULL," +
      " indexed_at INTEGER NOT NULL);\n" +
      "INSERT INTO games VALUES ('sig', 'game', 'winner', 1, 0, 2, 'mint', 1, 1, 1);\n",
  );

  await expect(runImport([source, target])).rejects.toThrow(
    "D1 historical backfill is incomplete; finish it in the existing Worker before exporting",
  );
  expect(readdirSync(directory)).toEqual(["export.sql"]);
});
