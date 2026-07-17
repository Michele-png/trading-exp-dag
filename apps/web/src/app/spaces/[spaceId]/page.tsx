import { notFound, redirect } from "next/navigation";

import { AppShell } from "@/components/app-shell";
import { GraphExplorer } from "@/components/graph-explorer";
import { ErrorState } from "@/components/ui-states";
import {
  getAuthenticatedUser,
  loadSpace,
} from "@/lib/server/ui-data";

export const dynamic = "force-dynamic";

export default async function SpacePage({
  params,
}: {
  params: Promise<{ spaceId: string }>;
}) {
  const { spaceId } = await params;
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
  if (!authentication.user) redirect(`/login?next=/spaces/${spaceId}`);

  let data: Awaited<ReturnType<typeof loadSpace>>;
  try {
    data = await loadSpace(authentication.client, spaceId);
  } catch (error) {
    return (
      <AppShell
        email={authentication.user.email ?? "Signed in"}
        wide
      >
        <ErrorState
          description={
            error instanceof Error
              ? error.message
              : "Space data could not be loaded."
          }
          title="Experiment space unavailable"
        />
      </AppShell>
    );
  }
  if (!data.space) notFound();
  return (
    <AppShell email={authentication.user.email ?? "Signed in"} wide>
      <GraphExplorer {...data} space={data.space} />
    </AppShell>
  );
}
