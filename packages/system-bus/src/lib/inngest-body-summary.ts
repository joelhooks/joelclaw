const INNGEST_BODY_SUMMARY_MIN_BYTES = 64 * 1024;

function shouldCloneForBodySummary(request: Request): boolean {
  if (request.method === "GET" || (request.method !== "POST" && request.method !== "PUT")) {
    return false;
  }
  const contentLength = request.headers.get("content-length");
  if (!contentLength || !/^\d+$/u.test(contentLength)) return false;
  const size = Number(contentLength);
  return Number.isSafeInteger(size) && size >= INNGEST_BODY_SUMMARY_MIN_BYTES;
}

export async function summarizeInngestRequestBody(
  request: Request,
  summarize: (rawBody: string | null) => Record<string, unknown> | null,
): Promise<Record<string, unknown> | null> {
  if (!shouldCloneForBodySummary(request)) return null;
  const rawBody = await request
    .clone()
    .text()
    .catch(() => null);
  return summarize(rawBody);
}
