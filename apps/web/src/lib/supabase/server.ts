import "server-only";

import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

import { getPublicEnvironment } from "@/lib/env";

export async function createServerSupabaseClient(): Promise<SupabaseClient> {
  const environment = getPublicEnvironment();
  const cookieStore = await cookies();

  return createServerClient(
    environment.NEXT_PUBLIC_SUPABASE_URL,
    environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookieUpdates) {
          try {
            for (const { name, value, options } of cookieUpdates) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Server Components cannot write cookies. `src/proxy.ts` refreshes
            // the session and applies updates on the response instead.
          }
        },
      },
    },
  );
}

export function createJwtSupabaseClient(accessToken: string): SupabaseClient {
  const environment = getPublicEnvironment();

  return createClient(
    environment.NEXT_PUBLIC_SUPABASE_URL,
    environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false,
      },
      global: {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    },
  );
}
