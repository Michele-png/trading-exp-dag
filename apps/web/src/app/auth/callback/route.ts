import { NextResponse } from "next/server";

import { createServerSupabaseClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

function safeDestination(value: string | null): string {
  return value?.startsWith("/") && !value.startsWith("//") ? value : "/";
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const destination = safeDestination(url.searchParams.get("next"));

  if (!code) {
    const failure = new URL("/login", url.origin);
    failure.searchParams.set("error", "missing_auth_code");
    return NextResponse.redirect(failure);
  }

  try {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) throw error;
    return NextResponse.redirect(new URL(destination, url.origin));
  } catch {
    const failure = new URL("/login", url.origin);
    failure.searchParams.set("error", "invalid_or_expired_link");
    return NextResponse.redirect(failure);
  }
}
