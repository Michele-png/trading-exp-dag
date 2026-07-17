import { FlaskConical, LogOut } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

export function AppShell({
  children,
  email,
  wide = false,
}: {
  children: ReactNode;
  email: string;
  wide?: boolean;
}) {
  return (
    <div className="min-h-dvh bg-[#080c14]">
      <header className="sticky top-0 z-40 border-b border-white/6 bg-[#080c14]/85 backdrop-blur-xl">
        <div
          className={`mx-auto flex h-16 items-center justify-between px-5 sm:px-7 ${
            wide ? "max-w-[1600px]" : "max-w-7xl"
          }`}
        >
          <Link
            className="flex items-center gap-3 text-sm font-semibold text-slate-100"
            href="/"
          >
            <span className="grid size-8 place-items-center rounded-lg border border-teal-300/20 bg-teal-300/10 text-teal-200">
              <FlaskConical aria-hidden className="size-4" />
            </span>
            QDAG
          </Link>
          <div className="flex items-center gap-3">
            <span className="hidden max-w-64 truncate text-xs text-slate-500 sm:block">
              {email}
            </span>
            <form action="/auth/signout" method="post">
              <button
                aria-label="Sign out"
                className="button-ghost size-9 p-0"
                title="Sign out"
                type="submit"
              >
                <LogOut aria-hidden className="size-4" />
              </button>
            </form>
          </div>
        </div>
      </header>
      <main
        className={`mx-auto px-5 py-8 sm:px-7 sm:py-10 ${
          wide ? "max-w-[1600px]" : "max-w-7xl"
        }`}
      >
        {children}
      </main>
    </div>
  );
}
