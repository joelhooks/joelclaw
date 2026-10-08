import { expect, test } from "bun:test";
import { HOST_SQLITE_BUSY_TIMEOUT_MS, openHostDatabase } from "./sqlite";

test("opens host SQLite connections with the bounded busy timeout", () => {
  const database = openHostDatabase(":memory:", { strict: true });
  try {
    expect(database.query("PRAGMA busy_timeout").get()).toEqual({
      timeout: HOST_SQLITE_BUSY_TIMEOUT_MS,
    });
    expect(HOST_SQLITE_BUSY_TIMEOUT_MS).toBe(5_000);
  } finally {
    database.close();
  }
});
