export function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function sanitizeAttribute(value: string): string {
  return value.replace(/"/g, "&quot;");
}
