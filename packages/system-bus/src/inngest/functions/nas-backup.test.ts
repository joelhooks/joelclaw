import { describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import {
  isLocalSnapshotPathWithinRoot,
  parseTypesenseSnapshotSource,
  stageRedisBackupFromCluster,
  stageTypesenseSnapshotForBackup,
} from "./nas-backup";

describe("Typesense backup source", () => {
  test("defaults to the native local Typesense source", () => {
    expect(parseTypesenseSnapshotSource(undefined)).toBe("local");
    expect(parseTypesenseSnapshotSource(" local ")).toBe("local");
    expect(parseTypesenseSnapshotSource("k8s")).toBe("k8s");
    expect(() => parseTypesenseSnapshotSource("pod")).toThrow("Invalid TYPESENSE_SNAPSHOT_SOURCE");
  });

  test("allows the configured root only for root-level maintenance", () => {
    const root = "/tmp/typesense-native-snapshots";

    expect(isLocalSnapshotPathWithinRoot(root, root)).toBe(false);
    expect(isLocalSnapshotPathWithinRoot(root, root, true)).toBe(true);
    expect(isLocalSnapshotPathWithinRoot(`${root}/20260731`, root)).toBe(true);
    expect(isLocalSnapshotPathWithinRoot("/tmp/typesense-other/20260731", root, true)).toBe(false);
  });

  test("uses a native snapshot directory without kubectl staging", async () => {
    const root = `/tmp/typesense-native-backup-test-${crypto.randomUUID()}`;
    const snapshotPath = `${root}/snapshot`;
    const stagedPath = `${root}/stage`;

    try {
      await mkdir(snapshotPath, { recursive: true });
      await Bun.write(`${snapshotPath}/manifest.json`, "{}");

      const result = await stageTypesenseSnapshotForBackup(snapshotPath, stagedPath, "local");

      expect(result).toEqual({ path: snapshotPath, staged: false });
      expect(await Bun.file(`${snapshotPath}/manifest.json`).text()).toBe("{}");
      expect(await Bun.file(stagedPath).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Redis backup source", () => {
  test("fails before BGSAVE when remote kubectl is missing", async () => {
    const commands: string[][] = [];

    await expect(
      stageRedisBackupFromCluster("/tmp/unused-redis-backup.rdb", {
        runCommand: async (command) => {
          commands.push(command);
          return {
            exitCode: 127,
            stdout: "",
            stderr: "test: /opt/homebrew/bin/kubectl: not found",
          };
        },
        sleep: async () => undefined,
        maxPolls: 1,
      }),
    ).rejects.toThrow("remote kubectl preflight on panda failed (exit 127)");

    expect(commands).toHaveLength(1);
    expect(commands[0]).toEqual([
      "ssh",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=8",
      "panda",
      "test",
      "-x",
      "/opt/homebrew/bin/kubectl",
    ]);
  });

  test("waits for a successful BGSAVE before streaming the RDB", async () => {
    const stagingPath = `/tmp/redis-backup-test-${crypto.randomUUID()}.rdb`;
    const outputs = [
      "",
      "100\n",
      "Background saving started\n",
      "rdb_bgsave_in_progress:1\r\nrdb_last_bgsave_status:ok\r\nrdb_last_save_time:100\r\n",
      "rdb_bgsave_in_progress:0\r\nrdb_last_bgsave_status:ok\r\nrdb_last_save_time:101\r\n",
      "",
    ];
    let call = 0;

    try {
      const result = await stageRedisBackupFromCluster(stagingPath, {
        runCommand: async (_command, options) => {
          const stdout = outputs[call] ?? "";
          call += 1;
          if (options?.stdoutPath) await Bun.write(options.stdoutPath, "redis-rdb");
          return { exitCode: 0, stdout, stderr: "" };
        },
        sleep: async () => undefined,
      });

      expect(result).toEqual({ lastSaveEpoch: 101 });
      expect(call).toBe(6);
      expect(await Bun.file(stagingPath).text()).toBe("redis-rdb");
    } finally {
      await rm(stagingPath, { force: true });
    }
  });
});
