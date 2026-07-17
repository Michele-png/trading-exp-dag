import { FlaskConical, GitBranch, LockKeyhole } from "lucide-react";
import { Suspense } from "react";

import { LoginForm } from "@/components/login-form";

export const dynamic = "force-dynamic";

export default function LoginPage() {
  return (
    <main className="relative grid min-h-dvh overflow-hidden bg-[#070b13] lg:grid-cols-[1.1fr_0.9fr]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(45,212,191,0.1),transparent_30%),radial-gradient(circle_at_75%_70%,rgba(96,165,250,0.08),transparent_34%)]" />
      <section className="relative hidden border-r border-white/7 px-12 py-14 lg:flex lg:flex-col lg:justify-between xl:px-20">
        <div className="flex items-center gap-3 text-sm font-semibold tracking-wide text-slate-200">
          <span className="grid size-9 place-items-center rounded-xl border border-teal-300/20 bg-teal-300/10 text-teal-200">
            <FlaskConical aria-hidden className="size-5" />
          </span>
          QDAG
        </div>
        <div className="max-w-xl">
          <p className="eyebrow">Experiment provenance</p>
          <h1 className="mt-5 text-balance text-5xl font-semibold leading-[1.08] tracking-[-0.045em] text-white xl:text-6xl">
            Keep every conclusion connected to its evidence.
          </h1>
          <p className="mt-6 max-w-lg text-lg leading-8 text-slate-400">
            A private, auditable registry for hypotheses, revisions, local
            runs, and the lineage between them.
          </p>
        </div>
        <div className="grid max-w-xl grid-cols-2 gap-4 text-sm text-slate-400">
          <div className="panel-muted flex items-start gap-3 p-4">
            <GitBranch
              aria-hidden
              className="mt-0.5 size-4 shrink-0 text-sky-300"
            />
            Lineage stays separate from scientific interpretation.
          </div>
          <div className="panel-muted flex items-start gap-3 p-4">
            <LockKeyhole
              aria-hidden
              className="mt-0.5 size-4 shrink-0 text-teal-300"
            />
            Workspace access is enforced by Supabase RLS.
          </div>
        </div>
      </section>
      <section className="relative flex min-h-dvh items-center justify-center px-6 py-12">
        <div className="w-full max-w-md">
          <div className="mb-10 flex items-center gap-3 lg:hidden">
            <span className="grid size-9 place-items-center rounded-xl border border-teal-300/20 bg-teal-300/10 text-teal-200">
              <FlaskConical aria-hidden className="size-5" />
            </span>
            <span className="font-semibold text-slate-100">QDAG</span>
          </div>
          <div className="panel border-white/10 p-7 shadow-2xl shadow-black/30 sm:p-9">
            <p className="eyebrow">Private workspace</p>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white">
              Sign in to continue
            </h2>
            <p className="mt-3 text-sm leading-6 text-slate-400">
              We&apos;ll email a one-time sign-in link. No password is stored.
            </p>
            <div className="mt-8">
              <Suspense fallback={<div className="h-32 animate-pulse" />}>
                <LoginForm />
              </Suspense>
            </div>
          </div>
          <p className="mt-6 text-center text-xs leading-5 text-slate-500">
            Access is limited to invited workspace members.
          </p>
        </div>
      </section>
    </main>
  );
}
