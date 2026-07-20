export type AgentSessionBackupCommandInput = {
  scriptPath: string;
  hosts: string;
  backupRoot: string;
  centralUrl: string;
  receiptPath: string;
  repairEnv: boolean;
};

export function buildAgentSessionBackupCommand(
  input: AgentSessionBackupCommandInput,
): string[] {
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
  ];
}
