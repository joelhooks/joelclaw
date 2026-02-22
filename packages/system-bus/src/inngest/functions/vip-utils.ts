const DEFAULT_VIP_SENDERS = [
  "alex hillman",
];

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function parseVipSendersFromEnv(): string[] {
  const raw = process.env.JOELCLAW_VIP_SENDERS ?? "";
  if (!raw.trim()) return [];
  return raw
    .split(",")
    .map((item) => normalize(item))
    .filter(Boolean);
}

export function getVipSenders(): string[] {
  const configured = parseVipSendersFromEnv();
  return Array.from(new Set([...DEFAULT_VIP_SENDERS, ...configured]));
}

export function isVipSender(from: string, fromName?: string): boolean {
  const haystack = `${fromName ?? ""} ${from}`.toLowerCase();
  return getVipSenders().some((vip) => haystack.includes(vip));
}

