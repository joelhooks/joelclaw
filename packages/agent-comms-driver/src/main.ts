import { Config, Effect, Schedule } from "effect";

import { makeLiveDriverPorts } from "./adapters";
import {
  AgentCommsDriver,
  DEFAULT_HEARTBEAT_REFRESH_MS,
  DEFAULT_HEARTBEAT_TTL_MS,
  DEFAULT_POKE_DEADLINE_MS,
  DEFAULT_SUCCESSOR_DEADLINE_MS,
} from "./driver";

const DRIVER_PID_FILE = "/tmp/joelclaw/agent-comms-driver.pid";

const main = Effect.gen(function* () {
  yield* Effect.promise(async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir("/tmp/joelclaw", { recursive: true });
    await writeFile(DRIVER_PID_FILE, `${process.pid}\n`, "utf8");
  });
  const target = yield* Config.string("GATEWAY_AGENT_TARGET");
  const successorBriefPath = yield* Config.string("GATEWAY_SUCCESSOR_BRIEF_PATH");
  const redisUrl = yield* Config.string("REDIS_URL").pipe(
    Config.withDefault("redis://127.0.0.1:6379"),
  );
  const heartbeatKey = yield* Config.string("GATEWAY_HEARTBEAT_KEY").pipe(
    Config.withDefault("gateway:agent:heartbeat"),
  );
  const heartbeatTtlMs = yield* Config.integer("GATEWAY_HEARTBEAT_TTL_MS").pipe(
    Config.withDefault(DEFAULT_HEARTBEAT_TTL_MS),
  );
  const refreshMs = yield* Config.integer("GATEWAY_HEARTBEAT_REFRESH_MS").pipe(
    Config.withDefault(DEFAULT_HEARTBEAT_REFRESH_MS),
  );
  const pokeDeadlineMs = yield* Config.integer("GATEWAY_POKE_DEADLINE_MS").pipe(
    Config.withDefault(DEFAULT_POKE_DEADLINE_MS),
  );
  const successorDeadlineMs = yield* Config.integer("GATEWAY_SUCCESSOR_DEADLINE_MS").pipe(
    Config.withDefault(DEFAULT_SUCCESSOR_DEADLINE_MS),
  );
  const receiptPath = yield* Config.string("GATEWAY_DRIVER_RECEIPT_PATH").pipe(
    Config.withDefault("/tmp/joelclaw/agent-comms-driver.jsonl"),
  );

  const herdrWorkspace = yield* Config.string("GATEWAY_HERDR_WORKSPACE").pipe(
    Config.withDefault(""),
  );
  const successorCommand = yield* Config.string("GATEWAY_SUCCESSOR_COMMAND").pipe(
    Config.withDefault(""),
  );
  const ports = makeLiveDriverPorts({
    target,
    successorBriefPath,
    redisUrl,
    receiptPath,
    ...(herdrWorkspace ? { herdrWorkspace } : {}),
    ...(successorCommand ? { successorCommand } : {}),
  });
  const driver = new AgentCommsDriver(ports, {
    heartbeatKey,
    heartbeatTtlMs,
    pokeDeadlineMs,
    successorDeadlineMs,
  });

  yield* driver.runPass().pipe(
    Effect.tapError((error) => Effect.logError("AgentCommsDriver.pass_failed", error)),
    Effect.ignore,
    Effect.repeat(Schedule.spaced(refreshMs)),
    Effect.ensuring(
      Effect.promise(async () => {
        driver.stop();
        await ports.close();
      }),
    ),
  );
});

Effect.runPromise(main).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
