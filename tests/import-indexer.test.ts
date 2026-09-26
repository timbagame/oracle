import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IndexerDatabase } from "../indexer/database.ts";
import { captureConsole, createRestorer, setArgv } from "./helpers/cli.ts";

const restorer = createRestorer();
afterEach(() => restorer.restoreAll());

test("imports a D1 export into a new indexer database", async () => {
  const directory = mkdtempSync(join(tmpdir(), "timba-import-indexer-"));
  restorer.add(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, "export.sql");
  const target = join(directory, "indexer.sqlite");
  writeFileSync(
    source,
    "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT);\n" +
      "INSERT INTO d1_migrations VALUES (1, '0001_init.sql');\n",
  );
  setArgv(restorer, "scripts/import-indexer.ts", [source, target]);
  const output = captureConsole(restorer);

  await import("../scripts/import-indexer.ts");

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
