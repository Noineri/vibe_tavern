import { Fragment, useEffect, useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { Attachment } from "@vibe-tavern/domain";
import { toast } from "sonner";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { useT } from "../../i18n/context.js";
import { cn } from "../../lib/cn.js";
import { ActionSheet, type ActionSheetItem } from "../shared/ActionSheet.js";
import { DestructiveConfirmModal } from "../shared/destructive-confirm-modal.js";
import { Icons } from "../shared/icons.js";
import { Modal } from "../shared/Modal.js";
import { modalPanelCls } from "../shared/modal-helpers.js";
import { CustomTooltip, TooltipProvider } from "../shared/Tooltip.js";
import { FileAttachmentChip } from "./file-attachment-chip.js";

export interface SentFileAttachmentActions {
  summarize(signal: AbortSignal): Promise<Attachment>;
  clearSummary(): Promise<Attachment>;
  setIncluded(included: boolean): Promise<void>;
  remove(): Promise<void>;
}

/** Surface-independent action machine. Canonical attachment state belongs to
 * the caller; this component owns only menus, transient work and cancellation. */
export function SentFileAttachment({ attachment, actions, onUpdated, onRemoved }: {
  attachment: Attachment;
  actions: SentFileAttachmentActions;
  onUpdated: (attachment: Attachment) => void;
  onRemoved: (attachmentId: string) => void;
}) {
  const { t, locale } = useT();
  const isMobile = useIsMobile();
  const [menuOpen, setMenuOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const active = useRef<AbortController | null>(null);
  const latest = useRef(attachment);
  latest.current = attachment;
  useEffect(() => () => { active.current?.abort(); }, []);

  const summarized = Boolean(attachment.description?.trim());
  const excluded = attachment.includeInPrompt === false;
  async function run(work: (signal: AbortSignal) => Promise<void>, summary = false, deletion = false) {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setMenuOpen(false);
    setBusy(true);
    setSummarizing(summary);
    try {
      await work(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) toast.error(deletion ? t("attachment_delete_failed") : error instanceof Error ? error.message : String(error));
    } finally {
      // Cancel frees the chip immediately; a late completion must not unlock
      // or paint over a subsequent action started on the same chip.
      if (active.current === controller) {
        active.current = null;
        setBusy(false);
        setSummarizing(false);
      }
    }
  }
  function cancel() {
    active.current?.abort();
    active.current = null;
    setBusy(false);
    setSummarizing(false);
  }
  const items: ActionSheetItem[] = [
    summarized
      ? { icon: <Icons.Undo />, label: t("attachment_restore_full_text"), action: () => void run(async () => { onUpdated(await actions.clearSummary()); }) }
      : { icon: <Icons.Sparkles />, label: t("attachment_summarize"), action: () => void run(async (signal) => {
        const result = await actions.summarize(signal);
        if (!signal.aborted) onUpdated(result);
      }, true) },
    ...(summarized ? [{ icon: <Icons.FileText />, label: t("attachment_show_summary"), action: () => setSummaryOpen(true) }] : []),
    { icon: excluded ? <Icons.Eye /> : <Icons.EyeOff />, label: excluded ? t("attachment_include") : t("attachment_exclude"), action: () => void run(async () => {
      await actions.setIncluded(excluded);
      onUpdated({ ...latest.current, includeInPrompt: excluded });
    }) },
    { icon: <Icons.Trash />, label: t("attachment_delete_title"), danger: true, separatorBefore: true, action: () => setConfirmDeleteOpen(true) },
  ];
  const status = summarizing ? (
    <span role="status" className="relative z-10 flex flex-wrap items-center gap-x-2 gap-y-1">
      {/* Existing message-action spinner chrome (message-shell-actions.tsx). */}
      <span aria-hidden className="h-3 w-3 shrink-0 animate-spin rounded-full border border-current border-t-transparent" />
      <span>{t("attachment_summarizing")}</span>
      <button type="button" className="cursor-pointer font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors hover:text-t1" onClick={cancel}>{t("cancel")}</button>
    </span>
  ) : excluded ? t("attachment_excluded") : summarized ? t("attachment_summarized", { tokens: (attachment.summaryTokenCount ?? 0).toLocaleString(locale) }) : undefined;

  return (
    <>
      <FileAttachmentChip attachment={attachment} status={status} excluded={excluded} trailing={isMobile ? (
        <button type="button" aria-label={t("attachment_file_actions")} aria-haspopup="dialog" aria-expanded={menuOpen} disabled={busy} className="absolute inset-0 cursor-pointer rounded-lg disabled:cursor-default" onClick={() => setMenuOpen(true)} />
      ) : (
        <DropdownMenu.Root modal={false} open={menuOpen} onOpenChange={setMenuOpen}>
          <TooltipProvider delayDuration={200}>
          <CustomTooltip content={t("attachment_file_actions")}>
            <DropdownMenu.Trigger asChild>
              <button type="button" aria-label={t("attachment_file_actions")} disabled={busy} className="flex shrink-0 cursor-pointer items-center gap-1 rounded px-[7px] py-[3px] font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors duration-100 hover:bg-s2 hover:text-t2 disabled:cursor-default disabled:opacity-40"><Icons.Ellipsis /></button>
            </DropdownMenu.Trigger>
          </CustomTooltip>
          </TooltipProvider>
          <DropdownMenu.Portal>
            <DropdownMenu.Content side="bottom" align="end" sideOffset={4} className="glass-blur z-[200] w-max max-w-[calc(100vw-32px)] rounded-md border border-border2 bg-glass-bg py-1 shadow-[0_8px_24px_rgba(0,0,0,0.4)]">
              {items.map((item) => (
                <Fragment key={item.label}>
                  {item.separatorBefore && <DropdownMenu.Separator className="my-1 h-px bg-border" />}
                  <DropdownMenu.Item disabled={busy} onSelect={item.action} className={cn(
                    "flex cursor-pointer items-center gap-2 px-3 py-[7px] text-[calc(var(--ui-fs)-2px)] outline-none transition-colors duration-100 [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0 data-[disabled]:opacity-40",
                    item.danger ? "text-danger-text hover:bg-danger-dim hover:text-danger-text data-[highlighted]:bg-danger-dim data-[highlighted]:text-danger-text" : "text-t2 hover:bg-s2 hover:text-t1 data-[highlighted]:bg-s2 data-[highlighted]:text-t1",
                  )}>{item.icon}{item.label}</DropdownMenu.Item>
                </Fragment>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )} />
      {isMobile && <ActionSheet open={menuOpen} onClose={() => setMenuOpen(false)} title={attachment.name} items={items.map((item) => ({ ...item, disabled: busy }))} />}
      <Modal open={summaryOpen} onClose={() => setSummaryOpen(false)} title={attachment.name}>
        <div className={cn(modalPanelCls, "flex max-h-[80dvh] w-[min(640px,calc(100vw-32px))] flex-col p-5")}>
          <div className="mb-4 flex items-start gap-3">
            <h2 className="min-w-0 flex-1 break-words font-ui text-[calc(var(--ui-fs)+2px)] font-medium text-t1">{attachment.name}</h2>
            <button type="button" aria-label={t("close")} className="cursor-pointer text-t3 transition-colors hover:text-t1" onClick={() => setSummaryOpen(false)}><Icons.Close /></button>
          </div>
          <div className="overflow-y-auto whitespace-pre-wrap break-words font-body text-[calc(var(--ui-fs))] text-t2">{attachment.description}</div>
        </div>
      </Modal>
      {confirmDeleteOpen && <DestructiveConfirmModal title={t("attachment_delete_title")} body={t("attachment_delete_msg")} confirmLabel={t("delete")} onCancel={() => setConfirmDeleteOpen(false)} onConfirm={() => {
        setConfirmDeleteOpen(false);
        void run(async () => {
          await actions.remove();
          toast.success(t("attachment_deleted"));
          onRemoved(attachment.id);
        }, false, true);
      }} />}
    </>
  );
}
