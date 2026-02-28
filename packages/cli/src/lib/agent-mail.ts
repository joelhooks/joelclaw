const DEFAULT_AGENT_MAIL_URL = "http://127.0.0.1:8765"

const normalizeBaseUrl = (value: string): string => value.replace(/\/+$/, "")

export const getAgentMailUrl = (): string => {
  const configured = process.env.AGENT_MAIL_URL?.trim()
  if (!configured) return DEFAULT_AGENT_MAIL_URL
  return normalizeBaseUrl(configured)
}

const toErrorDetail = (value: unknown): string => {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

const readResponseBody = async (response: Response): Promise<unknown> => {
  const text = await response.text()
  if (text.length === 0) return null

  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export async function fetchMailApi(path: string): Promise<unknown> {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`
  const response = await fetch(`${getAgentMailUrl()}${normalizedPath}`, {
    method: "GET",
    headers: { Accept: "application/json" },
  })

  const body = await readResponseBody(response)
  if (!response.ok) {
    throw new Error(
      `Agent Mail GET ${normalizedPath} failed (${response.status}): ${toErrorDetail(body)}`,
    )
  }

  return body
}

export async function callMcpTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(`${getAgentMailUrl()}/mcp`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `joelclaw-cli-${Date.now()}`,
      method: "tools/call",
      params: {
        name: toolName,
        arguments: args,
      },
    }),
  })

  const body = await readResponseBody(response)
  if (!response.ok) {
    throw new Error(
      `Agent Mail MCP ${toolName} failed (${response.status}): ${toErrorDetail(body)}`,
    )
  }

  if (!body || typeof body !== "object") {
    throw new Error(`Agent Mail MCP ${toolName} returned invalid JSON-RPC payload`)
  }

  const payload = body as {
    error?: { code?: number; message?: string; data?: unknown }
    result?: unknown
  }

  if (payload.error) {
    const code = payload.error.code ?? "unknown"
    const message = payload.error.message ?? "Unknown MCP error"
    const detail =
      payload.error.data === undefined ? "" : ` (${toErrorDetail(payload.error.data)})`
    throw new Error(`Agent Mail MCP ${toolName} error ${code}: ${message}${detail}`)
  }

  return payload.result
}
