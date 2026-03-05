export const GATEWAY_BEHAVIOR_BLOCK_REGEX =
  /<GATEWAY_BEHAVIOR_CONTRACT[^>]*>[\s\S]*?<\/GATEWAY_BEHAVIOR_CONTRACT>\s*/g

const DIRECTIVE_REGEX = /^\s*(KEEP|MORE|LESS|STOP|START):\s+(.+)$/gim

type DirectiveType = "keep" | "more" | "less" | "stop" | "start"

export type BehaviorDirectiveCapture = {
  type: DirectiveType
  text: string
}

export type BehaviorContractLike = {
  version?: number
  hash?: string
  directives?: Array<{
    type?: string
    text?: string
  }>
}

function normalizeDirectiveType(value: string): DirectiveType | null {
  const normalized = value.trim().toLowerCase()
  if (normalized === "keep") return "keep"
  if (normalized === "more") return "more"
  if (normalized === "less") return "less"
  if (normalized === "stop") return "stop"
  if (normalized === "start") return "start"
  return null
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

function directiveKey(entry: BehaviorDirectiveCapture): string {
  return `${entry.type}:${entry.text.toLowerCase()}`
}

function extractUserBody(prompt: string): string {
  if (!prompt.startsWith("---\nChannel:")) return prompt
  const marker = "\n---\n"
  const firstBoundary = prompt.indexOf(marker)
  if (firstBoundary < 0) return prompt
  const secondBoundary = prompt.indexOf(marker, firstBoundary + marker.length)
  if (secondBoundary < 0) return prompt
  return prompt.slice(secondBoundary + marker.length)
}

export function parseBehaviorDirectivesFromPrompt(prompt: string): BehaviorDirectiveCapture[] {
  if (typeof prompt !== "string" || prompt.trim().length === 0) return []
  if (prompt.includes("⚡ **Automated gateway event**")) return []

  const body = extractUserBody(prompt)
  const captures: BehaviorDirectiveCapture[] = []
  const seen = new Set<string>()

  for (const match of body.matchAll(DIRECTIVE_REGEX)) {
    const rawType = match[1] ?? ""
    const rawText = match[2] ?? ""
    const type = normalizeDirectiveType(rawType)
    const text = collapseWhitespace(rawText)

    if (!type || text.length === 0) continue

    const entry = { type, text }
    const key = directiveKey(entry)
    if (seen.has(key)) continue
    seen.add(key)
    captures.push(entry)
  }

  return captures
}

export function stripGatewayBehaviorContract(systemPrompt: string): string {
  if (!systemPrompt) return ""
  return systemPrompt.replace(GATEWAY_BEHAVIOR_BLOCK_REGEX, "").trim()
}

function formatDirectiveLine(directive: { type?: string; text?: string }): string | null {
  if (!directive || typeof directive !== "object") return null
  const type = typeof directive.type === "string" ? normalizeDirectiveType(directive.type) : null
  const text = typeof directive.text === "string" ? collapseWhitespace(directive.text) : ""
  if (!type || text.length === 0) return null
  return `- ${type.toUpperCase()}: ${text}`
}

export function renderGatewayBehaviorContractBlock(contract: BehaviorContractLike): string {
  const directives = Array.isArray(contract.directives) ? contract.directives : []
  const lines = directives
    .map((directive) => formatDirectiveLine(directive))
    .filter((line): line is string => typeof line === "string")

  if (lines.length === 0) return ""

  const version = Number.isFinite(contract.version) ? Number(contract.version) : 0
  const hash = typeof contract.hash === "string" ? contract.hash : ""

  return [
    `<GATEWAY_BEHAVIOR_CONTRACT version=\"${version}\" hash=\"${hash}\">`,
    ...lines,
    "</GATEWAY_BEHAVIOR_CONTRACT>",
  ].join("\n")
}

export function injectGatewayBehaviorContract(
  systemPrompt: string,
  contractBlock: string,
): {
  systemPrompt: string
  inserted: boolean
  placement: "before-role" | "prepend" | "none"
} {
  const withoutExisting = stripGatewayBehaviorContract(systemPrompt)
  const normalizedBlock = contractBlock.trim()

  if (normalizedBlock.length === 0) {
    return {
      systemPrompt: withoutExisting,
      inserted: false,
      placement: "none",
    }
  }

  const roleMatch = /(^|\n)#\s*Role\b/m.exec(withoutExisting)
  if (roleMatch && roleMatch.index != null) {
    const insertAt = roleMatch.index + (roleMatch[1] ? roleMatch[1].length : 0)
    const merged = `${withoutExisting.slice(0, insertAt)}${normalizedBlock}\n\n${withoutExisting.slice(insertAt)}`.trim()
    return {
      systemPrompt: merged,
      inserted: true,
      placement: "before-role",
    }
  }

  return {
    systemPrompt: `${normalizedBlock}\n\n${withoutExisting}`.trim(),
    inserted: true,
    placement: "prepend",
  }
}
