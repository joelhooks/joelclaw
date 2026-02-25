export type VaultIntent =
  | { kind: "path"; value: string }
  | { kind: "adr"; value: string }
  | { kind: "fuzzy"; value: string };
