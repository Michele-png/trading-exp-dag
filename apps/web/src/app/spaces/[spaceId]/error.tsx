"use client";

import { RotateCcw } from "lucide-react";

import { ErrorState } from "@/components/ui-states";

export default function SpaceError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="grid min-h-dvh place-items-center bg-[#080c14] px-5">
      <div className="w-full max-w-xl">
        <ErrorState
          action={
            <button
              className="button-secondary"
              onClick={reset}
              type="button"
            >
              <RotateCcw aria-hidden className="size-4" />
              Try again
            </button>
          }
          description="The graph could not be rendered. Your data was not modified."
          title="Space view failed"
        />
      </div>
    </main>
  );
}
