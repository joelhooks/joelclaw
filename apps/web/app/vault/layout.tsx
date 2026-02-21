/**
 * Vault layout — static shell, auth checked client-side.
 * Full route cache: this layout is pre-rendered at build time.
 * Content loads dynamically via Convex after auth verification.
 */
export default function VaultLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
