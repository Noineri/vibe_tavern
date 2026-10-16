import type { ReactNode } from "react";

/** One section card of the restructured editor (D5): a titled block that
 *  groups related fields instead of one flat per-backend list. */
export function TtsSectionCard({ title, testid, children }: { title: string; testid: string; children: ReactNode }): ReactNode {
  return (
    <div data-testid={testid} className="flex flex-col gap-3 rounded-lg border border-border bg-s1 px-3.5 py-3">
      <div className="font-ui text-[12px] font-medium tracking-wide text-t2 uppercase">{title}</div>
      {children}
    </div>
  );
}
