export type KeyValueRow = {
  key: string;
  value: string;
};

export function monospaceTable(rows: readonly KeyValueRow[], keyWidth = 14): string {
  const lines = rows.map((row) => {
    const key = row.key.length > keyWidth
      ? `${row.key.slice(0, keyWidth - 1)}…`
      : row.key.padEnd(keyWidth, " ");
    return `${key} ${row.value}`;
  });

  return `\`\`\`txt\n${lines.join("\n")}\n\`\`\``;
}

export function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-9;]*m/g, "");
}
