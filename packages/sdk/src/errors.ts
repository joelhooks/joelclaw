import type { CapabilityError } from "./capabilities"
import type { JoelclawEnvelope } from "./types"

export class JoelclawProcessError extends Error {
  readonly bin: string
  readonly args: readonly string[]
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string

  constructor(input: {
    message: string
    bin: string
    args: readonly string[]
    exitCode: number | null
    signal: NodeJS.Signals | null
    stdout: string
    stderr: string
  }) {
    super(input.message)
    this.name = "JoelclawProcessError"
    this.bin = input.bin
    this.args = input.args
    this.exitCode = input.exitCode
    this.signal = input.signal
    this.stdout = input.stdout
    this.stderr = input.stderr
  }
}

export class JoelclawCapabilityError extends Error {
  readonly capability: string
  readonly subcommand: string
  readonly causePayload: CapabilityError

  constructor(input: {
    capability: string
    subcommand: string
    error: CapabilityError
  }) {
    super(input.error.message)
    this.name = "JoelclawCapabilityError"
    this.capability = input.capability
    this.subcommand = input.subcommand
    this.causePayload = input.error
  }
}

export class JoelclawEnvelopeError<TResult = unknown> extends Error {
  readonly envelope: JoelclawEnvelope<TResult>

  constructor(envelope: JoelclawEnvelope<TResult>) {
    super(envelope.error?.message || `joelclaw command failed: ${envelope.command}`)
    this.name = "JoelclawEnvelopeError"
    this.envelope = envelope
  }
}
