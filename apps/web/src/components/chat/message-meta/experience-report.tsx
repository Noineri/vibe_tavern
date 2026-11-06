import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { renderExperienceEventLine, type ExperienceMessageReport } from "@vibe-tavern/domain";
import { useIsMobile } from "../../../hooks/use-mobile.js";
import { useT } from "../../../i18n/context.js";
import { registerMessageMeta, type MessageMetaDescriptor } from "../../../lib/message-meta-registry.js";
import { OverflowTooltip } from "../../shared/OverflowTooltip.js";
import { BottomSheet } from "../../shared/BottomSheet.js";
import { ScrollArea } from "../../shared/scroll-area.js";
import { Icons } from "../../shared/icons.js";
import { getModalPortal } from "../../shared/modal-helpers.js";

/** Message-owned read-only attachment, following the Dice meta-row placement
 * and desktop-popover/mobile-sheet chrome. Never reads live session state. */
export function ExperienceReportChip({ report }: { report: ExperienceMessageReport }) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  // At 320px, the meta row can wrap; within the chip only the user-authored
  // title shrinks. The icon and localized count keep their full width.
  const trigger = (
    <button
      type="button"
      className="inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1 rounded font-ui text-[calc(var(--ui-fs)-4px)] text-t3 transition-colors hover:text-t1"
      aria-label={`${t("experience_report_details_title")}: ${report.title}`}
      aria-expanded={open}
      onClick={isMobile ? () => setOpen(true) : undefined}
      data-testid="experience-report-chip"
    >
      <Icons.Sparkles className="shrink-0" />
      <OverflowTooltip asSpan text={report.title} className="min-w-0 max-w-[12rem]" />
      <span className="shrink-0">· {t("experience_report_event_count", { count: report.eventCount })}</span>
    </button>
  );

  if (isMobile) return (
    <>
      {trigger}
      <BottomSheet open={open} onClose={() => setOpen(false)} title={t("experience_report_details_title")}>
        <ExperienceReportDetail report={report} />
      </BottomSheet>
    </>
  );

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal container={getModalPortal() ?? undefined}>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={4}
          aria-label={t("experience_report_details_title")}
          className="glass-blur z-[220] w-[22rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-border2 bg-glass-bg shadow-[0_12px_28px_rgba(0,0,0,0.45)] outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
        >
          <ExperienceReportDetail report={report} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The same public frozen lines in either overlay; plain text, never HTML. */
export function ExperienceReportDetail({ report }: { report: ExperienceMessageReport }) {
  const { t } = useT();
  return (
    // CNR-8p: the shared detail body (desktop popover + mobile sheet) rides
    // the thin vertical lane instead of the native overflow-y-auto fallback;
    // the 70vh cap sits on the root, spacing + p-3 scroll with the lines.
    // Long sessions freeze many events, so the body truly overflows.
    <ScrollArea scrollbarSize="thin" className="max-h-[70vh]" contentClassName="space-y-2 p-3 font-ui [overflow-wrap:anywhere]" data-testid="experience-report-chip-detail">
      <h3 className="text-[calc(var(--ui-fs)-1px)] font-semibold text-t1">{report.title}</h3>
      <p className="text-[calc(var(--ui-fs)-3px)] text-t3">{t("experience_report_event_count", { count: report.eventCount })}</p>
      {report.summary && <p className="text-[calc(var(--ui-fs)-2px)] text-t2">{report.summary}</p>}
      {report.eventCount > report.events.length && (
        <p className="text-[calc(var(--ui-fs)-3px)] text-t3">
          {t("experience_report_recent_events", { shown: report.events.length, total: report.eventCount })}
        </p>
      )}
      <ul className="space-y-1 text-[calc(var(--ui-fs)-2px)] leading-relaxed text-t2">
        {report.events.map((event, index) => <li key={index} className="whitespace-pre-wrap">{renderExperienceEventLine(event, report.participants)}</li>)}
      </ul>
    </ScrollArea>
  );
}

export const experienceReportMetaDescriptor: MessageMetaDescriptor = {
  id: "experience-reports",
  order: 6,
  roles: ["user"],
  visible: (ctx) => (ctx.experienceReports?.length ?? 0) > 0,
  render: (ctx) => <>{ctx.experienceReports?.map((report, index) => <ExperienceReportChip key={index} report={report} />)}</>,
};

registerMessageMeta(experienceReportMetaDescriptor);
