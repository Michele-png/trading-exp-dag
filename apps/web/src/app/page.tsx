import { redirect } from "next/navigation";

import { AppShell } from "@/components/app-shell";
import { WorkspaceDashboard } from "@/components/dashboard";
import { ErrorState } from "@/components/ui-states";
import {
  getAuthenticatedUser,
  loadWorkspaceDashboard,
} from "@/lib/server/ui-data";

export const dynamic = "force-dynamic";

export default async function Home() {
  let authentication: Awaited<ReturnType<typeof getAuthenticatedUser>>;
  try {
    authentication = await getAuthenticatedUser();
  } catch (error) {
    return (
      <main className="grid min-h-dvh place-items-center bg-[#080c14] px-5">
        <div className="w-full max-w-xl">
          <ErrorState
            description={
              error instanceof Error
                ? error.message
                : "Supabase runtime configuration is unavailable."
            }
            title="Application configuration required"
          />
        </div>
      </main>
    );
  }

  if (!authentication.user) redirect("/login");

  let workspaces: Awaited<
    ReturnType<typeof loadWorkspaceDashboard>
  > | null = null;
  let dashboardError: unknown;
  try {
    workspaces = await loadWorkspaceDashboard(
      authentication.client,
      authentication.user.id,
    );
  } catch (error) {
    dashboardError = error;
  }

  if (dashboardError || !workspaces) {
    return (
      <AppShell email={authentication.user.email ?? "Signed in"}>
        <ErrorState
          description={
            dashboardError instanceof Error
              ? dashboardError.message
              : "Workspace data could not be loaded."
          }
          title="Dashboard unavailable"
        />
      </AppShell>
    );
  }

  return (
    <AppShell email={authentication.user.email ?? "Signed in"}>
      <WorkspaceDashboard workspaces={workspaces} />
    </AppShell>
  );
}
