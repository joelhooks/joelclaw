export const REDACTED_SECRET = "[REDACTED]";

const SECRET_KEYWORD =
  "(?:api[_-]?key|access[_-]?key|secret|token|password|passwd|bearer|auth(?:orization)?|signing[_-]?key|event[_-]?key|credential|private[_-]?key)";

const SHAPED_SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/gu,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/gu,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/gu,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu,
  /\bsignkey-(?:prod|test|branch)-[0-9a-f]{16,}\b/gu,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu,
  /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]{6,}@/gu,
];

const ASSIGNED_SECRET_PATTERN = new RegExp(
  `(${SECRET_KEYWORD}[A-Za-z0-9_-]*["']?\\s*(?:[:=]|=>)\\s*["']?)([^\\s"',;]{12,})`,
  "giu",
);

const NEARBY_SECRET_PATTERN = new RegExp(
  `((?:${SECRET_KEYWORD}|\\bkey\\b)[^\\n]{0,24}?)(?<![A-Za-z0-9+/_-])([A-Fa-f0-9]{32,}|[A-Za-z0-9+/_-]{32,}={0,2})(?![A-Za-z0-9+/_-])`,
  "giu",
);

const BEARER_PATTERN = /\b(Bearer\s+)([A-Za-z0-9._~+/-]{16,}=*)/gu;

function looksLikeSecretValue(value: string): boolean {
  return !value.startsWith("[REDACTED") && /[A-Za-z]/u.test(value) && /[0-9]/u.test(value);
}

export function redactSecrets(text: string): string {
  let redacted = text;
  for (const pattern of SHAPED_SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, REDACTED_SECRET);
  }
  redacted = redacted.replace(BEARER_PATTERN, `$1${REDACTED_SECRET}`);
  redacted = redacted.replace(ASSIGNED_SECRET_PATTERN, (match, prefix: string, value: string) =>
    looksLikeSecretValue(value) ? `${prefix}${REDACTED_SECRET}` : match,
  );
  redacted = redacted.replace(NEARBY_SECRET_PATTERN, `$1${REDACTED_SECRET}`);
  return redacted;
}
