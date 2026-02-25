export interface FormatConverter {
  /** Platform name */
  readonly platform: string;
  /** Convert markdown string to platform-formatted string */
  convert(md: string): string;
  /** Chunk a converted message into platform-safe pieces */
  chunk(md: string): string[];
  /** Max message length for this platform */
  readonly maxLength: number;
  /** Validate converted output against platform-specific rules */
  validate(output: string): ValidationResult;
}

/** Validation result from platform-specific output linting */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

export interface ValidationError {
  rule: string;
  message: string;
  position?: number; // char offset
}

export interface ValidationWarning {
  rule: string;
  message: string;
  position?: number;
}

export type MdastNode = import("mdast").Content;

export type MdastRoot = (import("mdast").Root & { children: MdastNode[] });
