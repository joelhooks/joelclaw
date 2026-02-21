import { isAuthenticated, fetchAuthQuery } from "../../lib/auth-server";
import { redirect } from "next/navigation";
import { api } from "../../convex/_generated/api";

export default async function VaultLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const authed = await isAuthenticated();
  if (!authed) redirect("/signin");

  const owner = await fetchAuthQuery(api.auth.isOwner);
  if (!owner) redirect("/");

  return <>{children}</>;
}
