import { Context, Data, Effect, Layer } from "effect";

export class ClickHouseError extends Data.TaggedError("ClickHouseError")<{
  readonly operation: string;
  readonly code: string;
  readonly status?: number;
  readonly cause?: unknown;
}> {}

export interface ClickHouseRequest {
  readonly sql: string;
  readonly body?: string;
}

export interface ClickHouseClientService {
  readonly execute: (request: ClickHouseRequest) => Effect.Effect<string, ClickHouseError>;
}

export class ClickHouseClient extends Context.Tag("@joelclaw/message-journal/ClickHouseClient")<
  ClickHouseClient,
  ClickHouseClientService
>() {}

export interface ClickHouseIdentity {
  readonly url: string;
  readonly username: string;
  readonly password: string;
}

export function makeClickHouseClient(identity: ClickHouseIdentity): ClickHouseClientService {
  const url = identity.url.replace(/\/+$/u, "");

  return ClickHouseClient.of({
    execute: Effect.fn("MessageJournal.ClickHouse.execute")(function* (request) {
      const response = yield* Effect.tryPromise({
        try: (signal) =>
          fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "text/plain; charset=utf-8",
              "X-ClickHouse-User": identity.username,
              "X-ClickHouse-Key": identity.password,
            },
            body: request.body === undefined ? request.sql : `${request.sql}\n${request.body}`,
            signal,
          }),
        catch: (cause) =>
          new ClickHouseError({
            operation: "execute",
            code: "CLICKHOUSE_REQUEST_FAILED",
            cause,
          }),
      });

      const responseBody = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: (cause) =>
          new ClickHouseError({
            operation: "read-response",
            code: "CLICKHOUSE_RESPONSE_READ_FAILED",
            status: response.status,
            cause,
          }),
      });

      if (!response.ok) {
        return yield* Effect.fail(
          new ClickHouseError({
            operation: "execute",
            code: "CLICKHOUSE_REJECTED",
            status: response.status,
          })
        );
      }

      return responseBody;
    }),
  });
}

export const clickHouseClientLayer = (identity: ClickHouseIdentity) =>
  Layer.succeed(ClickHouseClient, makeClickHouseClient(identity));

export function parseJsonEachRow(body: string): ReadonlyArray<Record<string, unknown>> {
  if (body.trim().length === 0) return [];
  return body
    .trim()
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

export function jsonEachRow(rows: ReadonlyArray<Record<string, unknown>>): string {
  return rows.map((row) => JSON.stringify(row)).join("\n");
}
