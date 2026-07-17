"use client";

import { ArrowRight, CheckCircle2, LoaderCircle } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { FormEvent, useState } from "react";

import { createBrowserSupabaseClient } from "@/lib/supabase/browser";

export function LoginForm() {
  const searchParams = useSearchParams();
  const callbackError = searchParams.get("error");
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<
    { kind: "idle" | "loading" | "sent" | "error"; message?: string }
  >({ kind: "idle" });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus({ kind: "loading" });

    try {
      const next = searchParams.get("next");
      const callbackUrl = new URL("/auth/callback", window.location.origin);
      if (next?.startsWith("/") && !next.startsWith("//")) {
        callbackUrl.searchParams.set("next", next);
      }
      const supabase = createBrowserSupabaseClient();
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: callbackUrl.toString(),
          shouldCreateUser: false,
        },
      });
      if (error) throw error;
      setStatus({
        kind: "sent",
        message: "Check your inbox. The link expires shortly.",
      });
    } catch (error) {
      setStatus({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "The sign-in link could not be sent.",
      });
    }
  }

  return (
    <form className="space-y-5" onSubmit={submit}>
      <div className="space-y-2">
        <label
          className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400"
          htmlFor="email"
        >
          Work email
        </label>
        <input
          autoComplete="email"
          autoFocus
          className="field h-12"
          disabled={status.kind === "loading" || status.kind === "sent"}
          id="email"
          name="email"
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@company.com"
          required
          type="email"
          value={email}
        />
      </div>
      <button
        className="button-primary h-12 w-full"
        disabled={status.kind === "loading" || status.kind === "sent"}
        type="submit"
      >
        {status.kind === "loading" ? (
          <LoaderCircle aria-hidden className="size-4 animate-spin" />
        ) : status.kind === "sent" ? (
          <CheckCircle2 aria-hidden className="size-4" />
        ) : (
          <ArrowRight aria-hidden className="size-4" />
        )}
        {status.kind === "sent" ? "Link sent" : "Send magic link"}
      </button>
      {status.message ? (
        <p
          className={
            status.kind === "error"
              ? "text-sm text-rose-300"
              : "text-sm text-emerald-300"
          }
          role={status.kind === "error" ? "alert" : "status"}
        >
          {status.message}
        </p>
      ) : null}
      {callbackError && status.kind === "idle" ? (
        <p className="text-sm text-rose-300" role="alert">
          This sign-in link is invalid or expired. Request a new one.
        </p>
      ) : null}
    </form>
  );
}
