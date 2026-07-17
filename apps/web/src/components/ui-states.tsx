import { AlertTriangle, FolderSearch, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

interface StateProps {
  title: string;
  description: string;
  action?: ReactNode;
  icon?: LucideIcon;
}

export function EmptyState({
  title,
  description,
  action,
  icon: Icon = FolderSearch,
}: StateProps) {
  return (
    <section
      className="panel-muted flex min-h-64 flex-col items-center justify-center px-6 py-12 text-center"
      data-testid="empty-state"
    >
      <span className="grid size-11 place-items-center rounded-2xl border border-white/8 bg-white/4 text-slate-400">
        <Icon aria-hidden className="size-5" />
      </span>
      <h2 className="mt-4 text-base font-semibold text-slate-100">{title}</h2>
      <p className="mt-2 max-w-md text-sm leading-6 text-slate-400">
        {description}
      </p>
      {action ? <div className="mt-5">{action}</div> : null}
    </section>
  );
}

export function ErrorState({
  title,
  description,
  action,
}: Omit<StateProps, "icon">) {
  return (
    <section
      className="rounded-2xl border border-rose-300/15 bg-rose-300/5 px-6 py-8"
      data-testid="error-state"
      role="alert"
    >
      <div className="flex items-start gap-4">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-rose-300/10 text-rose-300">
          <AlertTriangle aria-hidden className="size-5" />
        </span>
        <div>
          <h2 className="font-semibold text-rose-100">{title}</h2>
          <p className="mt-1 text-sm leading-6 text-rose-100/65">
            {description}
          </p>
          {action ? <div className="mt-4">{action}</div> : null}
        </div>
      </div>
    </section>
  );
}
