import { Database, type DatabaseOptions } from "bun:sqlite";

export const HOST_SQLITE_BUSY_TIMEOUT_MS = 5_000;

export function openHostDatabase(filename: string, options?: number | DatabaseOptions): Database {
  const database = new Database(filename, options);
  database.exec(`PRAGMA busy_timeout = ${HOST_SQLITE_BUSY_TIMEOUT_MS}`);
  return database;
}
