export interface FormatConverter {
  /** Platform name */
  readonly platform: string;
  /** Convert markdown string to platform-formatted string */
  convert(md: string): string;
  /** Chunk a converted message into platform-safe pieces */
  chunk(md: string): string[];
  /** Max message length for this platform */
  readonly maxLength: number;
}

export type MdastNode = import("mdast").Content;

export type MdastRoot = (import("mdast").Root & { children: MdastNode[] });
