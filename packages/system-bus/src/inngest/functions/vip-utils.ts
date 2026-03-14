const DEFAULT_VIP_SENDERS = [
  "alex hillman",
  "alex@indyhall.org",
];

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

export function extractVipSenderEmail(value: string): string {
  const normalized = normalize(value);
  if (!normalized) return "";

  const match = normalized.match(/<([^>]+)>/u);
  const candidate = normalize(match?.[1] ?? normalized);
  return candidate.includes("@") ? candidate : "";
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
  const haystack = normalize(`${fromName ?? ""} ${from}`);
  const fromEmail = extractVipSenderEmail(from);

  return getVipSenders().some((vip) => {
    const normalizedVip = normalize(vip);
    if (normalizedVip && haystack.includes(normalizedVip)) return true;

    const vipEmail = extractVipSenderEmail(vip);
    return Boolean(vipEmail && fromEmail && vipEmail === fromEmail);
  });
}
