import { isAuthenticated } from "@/lib/auth-server";
import { redirect } from "next/navigation";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const authed = await isAuthenticated();
  if (!authed) {
    redirect("/sign-in");
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold tracking-tight">Dashboard</h1>
        <span className="text-xs text-neutral-500">joelclaw system</span>
      </div>
      {children}
    </div>
  );
}
