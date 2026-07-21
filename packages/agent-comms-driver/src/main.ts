import { Config, Effect, Schedule } from "effect";

import { makeLiveDriverPorts } from "./adapters";
import {
  AgentCommsDriver,
  DEFAULT_HEARTBEAT_REFRESH_MS,
  DEFAULT_HEARTBEAT_TTL_MS,
  DEFAULT_POKE_DEADLINE_MS,
  DEFAULT_SUCCESSOR_DEADLINE_MS,
} from "./driver";

const main = Effect.gen(function* () {
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

  const ports = makeLiveDriverPorts({ target, successorBriefPath, redisUrl, receiptPath });
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
