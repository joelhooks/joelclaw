export type AgentSessionBackupCommandInput = {
  scriptPath: string;
  hosts: string;
  backupRoot: string;
  centralUrl: string;
  receiptPath: string;
  repairEnv: boolean;
  /** SSH target for the NAS. When set, backupRoot is a path on the NAS and no local mount is needed. */
  backupSsh?: string;
  backupSshFlags?: string;
  /**
   * Timeout for the post-copy file-count walk per source. The default 120s cannot finish over
   * SMB on trees like runs-dev (600k+ files). The job runs detached, so a long wait is cheap.
   */
  statTimeoutMs?: number;
};

export function buildAgentSessionBackupCommand(
  input: AgentSessionBackupCommandInput,
): string[] {
  const backupSsh = input.backupSsh?.trim() ?? "";
  const backupSshFlags = input.backupSshFlags?.trim() ?? "";
  return [
    "bun",
    input.scriptPath,
    "--hosts",
    input.hosts,
    "--backup-root",
    input.backupRoot,
    "--central-url",
    input.centralUrl,
    "--sync=true",
    "--receipt",
    input.receiptPath,
    ...(input.repairEnv ? ["--repair-env"] : []),
    ...(backupSsh ? ["--backup-ssh", backupSsh] : []),
    ...(backupSsh && backupSshFlags ? ["--backup-ssh-flags", backupSshFlags] : []),
    ...(input.statTimeoutMs && input.statTimeoutMs > 0
      ? ["--stat-timeout-ms", String(Math.floor(input.statTimeoutMs))]
      : []),
  ];
}
