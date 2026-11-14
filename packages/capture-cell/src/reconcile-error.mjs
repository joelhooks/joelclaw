// Diagnostics are allowlisted, not scrubbed copies of arbitrary dependency errors.
// Raw errors can contain SQL, credentials, hostnames and event payloads.
const PG_TYPES =
  "(?:character varying|character|text|uuid|integer|bigint|smallint|boolean|jsonb?|numeric|unknown)";
const OPERATOR_ERROR = new RegExp(
  `^ERROR: {1,2}operator does not exist: (${PG_TYPES}) ([=<>!~+*/%-]{1,3}) (${PG_TYPES})$`,
  "u",
);

export function redactedPsqlLine(stderr = "") {
  const first = String(stderr).split(/\r?\n/u, 1)[0];
  const operator = OPERATOR_ERROR.exec(first);
  if (operator)
    return `ERROR: operator does not exist: ${operator[1]} ${operator[2]} ${operator[3]}`;
  const named =
    /^(ERROR|FATAL): {1,2}(column|relation|database|role|schema|type) "(?:[^"\r\n]|"")*" (does not exist|already exists)$/u.exec(
      first,
    );
  if (named) return `${named[1]}: ${named[2]} [redacted] ${named[3]}`;
  const value =
    /^(ERROR|FATAL): {1,2}(syntax error at or near|password authentication failed for user|permission denied for (?:table|relation|schema|database|sequence)|invalid input syntax for type (?:uuid|integer|bigint|boolean|json|jsonb)):? .+$/u.exec(
      first,
    );
  if (value) return `${value[1]}: ${value[2]} [redacted]`;
  if (first.startsWith("psql: error: could not translate host name "))
    return "psql: error: could not translate host name [redacted]";
  for (const diagnostic of [
    "canceling statement due to statement timeout",
    "canceling statement due to lock timeout",
    "cannot execute INSERT in a read-only transaction",
    "cannot execute UPDATE in a read-only transaction",
    "cannot execute DELETE in a read-only transaction",
    "the database system is starting up",
    "the database system is shutting down",
    "sorry, too many clients already",
  ]) {
    if (first === `ERROR: ${diagnostic}` || first === `ERROR:  ${diagnostic}`)
      return `ERROR: ${diagnostic}`;
    if (first === `FATAL: ${diagnostic}` || first === `FATAL:  ${diagnostic}`)
      return `FATAL: ${diagnostic}`;
  }
  if (/^psql: (?:error: )?connection to server /u.test(first))
    return "psql: connection to server [redacted]";
  const severity = /^(ERROR|FATAL|PANIC|psql):/u.exec(first)?.[1];
  return first ? `${severity ? `${severity}: ` : ""}[redacted]` : "[unavailable]";
}

export class ReconcileFailure extends Error {
  constructor(stage, { exit = null, stderr = "", status = null } = {}) {
    super("reconcile_failed");
    this.name = "ReconcileFailure";
    this.failure = Object.freeze({
      stage: ["pg", "index", "post", "config"].includes(stage) ? stage : "config",
      ...(stage === "pg"
        ? { exit: Number.isInteger(exit) ? exit : null, stderr: redactedPsqlLine(stderr) }
        : { status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null }),
    });
  }
}

export function reconcileFailure(error, stage = "config") {
  return error instanceof ReconcileFailure ? error : new ReconcileFailure(stage);
}

export function logReconcileFailure(error, log = console.error) {
  const failure = reconcileFailure(error).failure;
  log(
    `capture.reconcile.failed ${Object.entries(failure)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(" ")}`,
  );
}
