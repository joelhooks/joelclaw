import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const HOME_DIR = process.env.HOME ?? "/Users/joel";

const LOOKS_LIKE_JSON_OBJECT =
  (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);

const normalizeString = (value: unknown, fallback: string): string =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;

const normalizePositiveInt = (value: unknown, fallback: number): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = Math.floor(value);
    return normalized > 0 ? normalized : fallback;
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  return fallback;
};

const parsePositiveEnvInt = (name: string, fallback: number): number =>
  normalizePositiveInt(process.env[name], fallback);

type BackupFailureRouterConfigFile = {
  selfHealing?: {
    router?: unknown;
    transport?: unknown;
  };
  backupFailureRouter?: {
    model?: unknown;
    fallbackModel?: unknown;
    maxRetries?: unknown;
    sleepMinMs?: unknown;
    sleepMaxMs?: unknown;
    sleepStepMs?: unknown;
  };
  backupTransport?: {
    nasRecoveryWindowHours?: unknown;
    nasMaxAttempts?: unknown;
    nasRetryBaseMs?: unknown;
    nasRetryMaxMs?: unknown;
    nasSshHost?: unknown;
    nasSshFlags?: unknown;
    nasHddRoot?: unknown;
    nasNvmeRoot?: unknown;
  };
};

type SelfHealingRouterConfig = {
  readonly model: string;
  readonly fallbackModel: string;
  readonly maxRetries: number;
  readonly sleepMinMs: number;
  readonly sleepMaxMs: number;
  readonly sleepStepMs: number;
};

type SelfHealingTransportConfig = {
  readonly recoveryWindowHours: number;
  readonly maxAttempts: number;
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
  readonly nasSshHost: string;
  readonly nasSshFlags: string;
  readonly nasHddRoot: string;
  readonly nasNvmeRoot: string;
};

type BackupFailureRouterConfig = {
  readonly failureRouter: SelfHealingRouterConfig;
  readonly transport: SelfHealingTransportConfig;
};

export const SYSTEM_BUS_CONFIG_PATH = join(HOME_DIR, ".joelclaw", "system-bus.config.json");

const DEFAULT_SELF_HEALING_ROUTER = {
  model: "gpt-5.2-codex-spark",
  fallbackModel: "gpt-5.3-codex",
  maxRetries: 5,
  sleepMinMs: 5 * 60_000,
  sleepMaxMs: 4 * 60 * 60_000,
  sleepStepMs: 30_000,
};

const DEFAULT_SELF_HEALING_TRANSPORT = {
  recoveryWindowHours: 4,
  maxAttempts: 12,
  retryBaseMs: 10_000,
  retryMaxMs: 120_000,
  nasSshHost: "joel@three-body",
  nasSshFlags: "-o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=2",
  nasHddRoot: "/Volumes/three-body",
  nasNvmeRoot: "/Volumes/nas-nvme",
};

function loadConfigFile(): BackupFailureRouterConfigFile {
  if (!existsSync(SYSTEM_BUS_CONFIG_PATH)) {
    return {};
  }

  const raw = readFileSync(SYSTEM_BUS_CONFIG_PATH, "utf-8");
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return LOOKS_LIKE_JSON_OBJECT(parsed) ? (parsed as BackupFailureRouterConfigFile) : {};
  } catch {
    return {};
  }
}

export function loadBackupFailureRouterConfig(): BackupFailureRouterConfig {
  const fileConfig = loadConfigFile();
  const fileSelfHealing = LOOKS_LIKE_JSON_OBJECT(fileConfig.selfHealing)
    ? fileConfig.selfHealing as { router?: unknown; transport?: unknown }
    : {};
  const fileRouter = LOOKS_LIKE_JSON_OBJECT(fileConfig.backupFailureRouter)
    ? fileConfig.backupFailureRouter
    : {};
  const fileRouterFromSelfHealing = LOOKS_LIKE_JSON_OBJECT(fileSelfHealing.router)
    ? fileSelfHealing.router
    : {};
  const fileTransportFromSelfHealing = LOOKS_LIKE_JSON_OBJECT(fileSelfHealing.transport)
    ? fileSelfHealing.transport
    : {};
  const fileTransport = LOOKS_LIKE_JSON_OBJECT(fileConfig.backupTransport)
    ? fileConfig.backupTransport
    : {};
  const envRouterModel = process.env.SELF_HEALING_ROUTER_MODEL;
  const envRouterFallbackModel = process.env.SELF_HEALING_ROUTER_FALLBACK_MODEL;
  const envRouterMaxRetries = process.env.SELF_HEALING_ROUTER_MAX_RETRIES;
  const envSleepMinMs = process.env.SELF_HEALING_ROUTER_SLEEP_MIN_MS;
  const envSleepMaxMs = process.env.SELF_HEALING_ROUTER_SLEEP_MAX_MS;
  const envSleepStepMs = process.env.SELF_HEALING_ROUTER_SLEEP_STEP_MS;
  const envRecoveryWindow = process.env.SELF_HEALING_RECOVERY_WINDOW_HOURS;
  const envMaxAttempts = process.env.SELF_HEALING_MAX_ATTEMPTS;
  const envRetryBaseMs = process.env.SELF_HEALING_RETRY_BASE_MS;
  const envRetryMaxMs = process.env.SELF_HEALING_RETRY_MAX_MS;
  const envNasSshHost = process.env.SELF_HEALING_NAS_HOST;
  const envNasSshFlags = process.env.SELF_HEALING_NAS_FLAGS;
  const envNasHddRoot = process.env.SELF_HEALING_NAS_HDD_ROOT;
  const envNasNvmeRoot = process.env.SELF_HEALING_NAS_NVME_ROOT;

  return {
    failureRouter: {
      model: normalizeString(
        envRouterModel,
        normalizeString(process.env.BACKUP_FAILURE_ROUTER_MODEL, normalizeString(
          (fileRouter.model ?? fileRouterFromSelfHealing.model),
          DEFAULT_SELF_HEALING_ROUTER.model,
        )),
      ),
      fallbackModel: normalizeString(
        envRouterFallbackModel,
        normalizeString(process.env.BACKUP_FAILURE_ROUTER_FALLBACK_MODEL, normalizeString(
          (fileRouter.fallbackModel ?? fileRouterFromSelfHealing.fallbackModel),
          DEFAULT_SELF_HEALING_ROUTER.fallbackModel,
        )),
      ),
      maxRetries: parsePositiveEnvInt(
        "BACKUP_ROUTER_MAX_RETRIES",
        parsePositiveEnvInt(
          "SELF_HEALING_ROUTER_MAX_RETRIES",
          normalizePositiveInt(
            (fileRouter.maxRetries ?? fileRouterFromSelfHealing.maxRetries),
            DEFAULT_SELF_HEALING_ROUTER.maxRetries,
          ),
        ),
      ),
      sleepMinMs: parsePositiveEnvInt(
        "BACKUP_ROUTER_SLEEP_MIN_MS",
        parsePositiveEnvInt(
          "SELF_HEALING_ROUTER_SLEEP_MIN_MS",
          normalizePositiveInt(
            (fileRouter.sleepMinMs ?? fileRouterFromSelfHealing.sleepMinMs),
            DEFAULT_SELF_HEALING_ROUTER.sleepMinMs,
          ),
        ),
      ),
      sleepMaxMs: parsePositiveEnvInt(
        "BACKUP_ROUTER_SLEEP_MAX_MS",
        parsePositiveEnvInt(
          "SELF_HEALING_ROUTER_SLEEP_MAX_MS",
          normalizePositiveInt(
            (fileRouter.sleepMaxMs ?? fileRouterFromSelfHealing.sleepMaxMs),
            DEFAULT_SELF_HEALING_ROUTER.sleepMaxMs,
          ),
        ),
      ),
      sleepStepMs: parsePositiveEnvInt(
        "BACKUP_ROUTER_SLEEP_STEP_MS",
        parsePositiveEnvInt(
          "SELF_HEALING_ROUTER_SLEEP_STEP_MS",
          normalizePositiveInt(
            (fileRouter.sleepStepMs ?? fileRouterFromSelfHealing.sleepStepMs),
            DEFAULT_SELF_HEALING_ROUTER.sleepStepMs,
          ),
        ),
      ),
    },
    transport: {
      recoveryWindowHours: parsePositiveEnvInt(
        "NAS_BACKUP_RECOVERY_WINDOW_HOURS",
        parsePositiveEnvInt(
          "SELF_HEALING_RECOVERY_WINDOW_HOURS",
          normalizePositiveInt(
            (fileTransport.nasRecoveryWindowHours ?? fileTransportFromSelfHealing.recoveryWindowHours ?? fileTransportFromSelfHealing.nasRecoveryWindowHours),
            DEFAULT_SELF_HEALING_TRANSPORT.recoveryWindowHours,
          ),
        ),
      ),
      maxAttempts: parsePositiveEnvInt(
        "NAS_BACKUP_MAX_ATTEMPTS",
        parsePositiveEnvInt(
          "SELF_HEALING_MAX_ATTEMPTS",
          normalizePositiveInt(
            (fileTransport.nasMaxAttempts ?? fileTransportFromSelfHealing.maxAttempts),
            DEFAULT_SELF_HEALING_TRANSPORT.maxAttempts,
          ),
        ),
      ),
      retryBaseMs: parsePositiveEnvInt(
        "NAS_BACKUP_RETRY_BASE_MS",
        parsePositiveEnvInt(
          "SELF_HEALING_RETRY_BASE_MS",
          normalizePositiveInt(
            (fileTransport.nasRetryBaseMs ?? fileTransportFromSelfHealing.retryBaseMs),
            DEFAULT_SELF_HEALING_TRANSPORT.retryBaseMs,
          ),
        ),
      ),
      retryMaxMs: parsePositiveEnvInt(
        "NAS_BACKUP_RETRY_MAX_MS",
        parsePositiveEnvInt(
          "SELF_HEALING_RETRY_MAX_MS",
          normalizePositiveInt(
            (fileTransport.nasRetryMaxMs ?? fileTransportFromSelfHealing.retryMaxMs),
            DEFAULT_SELF_HEALING_TRANSPORT.retryMaxMs,
          ),
        ),
      ),
      nasSshHost: normalizeString(
        envNasSshHost,
        normalizeString(
          process.env.NAS_SSH_HOST,
          normalizeString(
            fileTransport.nasSshHost,
            normalizeString(fileTransportFromSelfHealing.nasSshHost, DEFAULT_SELF_HEALING_TRANSPORT.nasSshHost),
          ),
        ),
      ),
      nasSshFlags: normalizeString(
        envNasSshFlags,
        normalizeString(
          process.env.NAS_SSH_FLAGS,
          normalizeString(
            fileTransport.nasSshFlags,
            normalizeString(fileTransportFromSelfHealing.nasSshFlags, DEFAULT_SELF_HEALING_TRANSPORT.nasSshFlags),
          ),
        ),
      ),
      nasHddRoot: normalizeString(
        envNasHddRoot,
        normalizeString(
          process.env.NAS_HDD_ROOT,
          normalizeString(
            fileTransport.nasHddRoot,
            normalizeString(fileTransportFromSelfHealing.nasHddRoot, DEFAULT_SELF_HEALING_TRANSPORT.nasHddRoot),
          ),
        ),
      ),
      nasNvmeRoot: normalizeString(
        envNasNvmeRoot,
        normalizeString(
          process.env.NAS_NVME_ROOT,
          normalizeString(
            fileTransport.nasNvmeRoot,
            normalizeString(fileTransportFromSelfHealing.nasNvmeRoot, DEFAULT_SELF_HEALING_TRANSPORT.nasNvmeRoot),
          ),
        ),
      ),
    },
  };
}
