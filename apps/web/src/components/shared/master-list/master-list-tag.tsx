import type { ReactNode } from "react";

// forks: 0 — master-list primitive source: the ONE text-tag shape every
// master-list row and detail header renders («Встроенный» under a skill
// name, …). Consumers pass the label (data), never classes — the chrome
// lives here, in exactly one place.

export function MasterListTag({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 rounded bg-s3 px-1.5 py-px font-ui text-[calc(var(--ui-fs)-3px)] text-t2">
      {children}
    </span>
  );
}
