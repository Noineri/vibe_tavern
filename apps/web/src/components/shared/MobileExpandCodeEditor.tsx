import { useState } from "react";
import type { Extension } from "@codemirror/state";
import { Icons } from "./icons.js";
import { CodeEditor } from "./CodeEditor.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { useT } from "../../i18n/context.js";

interface MobileExpandCodeEditorProps {
  /** Current buffer text (mirrored into the fullscreen editor). */
  value: string;
  /** Live edit callback (same contract as the inline CodeEditor). */
  onChange: (value: string) => void;
  /** Header label for the fullscreen session (buffer name). */
  label?: string;
  /** Read-only mirror (review mode / generation freeze, CD-3). */
  readOnly?: boolean;
  /** CM6 extensions mirrored into the fullscreen editor (CD-4 diff
   *  decorations — the review surface stays usable fullscreen). */
  extensions?: Extension[];
  /** The inline editor element to wrap. */
  children: React.ReactNode;
}

/**
 * The code-editor counterpart of MobileExpandTextarea: on mobile, overlays an
 * expand button on the inline editor and opens a fullscreen CodeMirror session
 * with the same chrome (← label Готово, `fixed inset-0` glass overlay).
 *
 * Deliberate divergence from the textarea wrapper: NO draft/commit step. A code
 * buffer is itself a draft (the copilot buffers have their own dirty/save flow
 * via the toolbar save button), so edits pass through live and «Готово» just
 * closes. Review-mode `readOnly` and the diff decorations are mirrored in, so
 * the fullscreen session is exactly the inline document, only bigger.
 *
 * Desktop: renders children unchanged (no button, no overlay).
 */
export function MobileExpandCodeEditor({
  value,
  onChange,
  label,
  readOnly = false,
  extensions,
  children,
}: MobileExpandCodeEditorProps) {
  const isMobile = useIsMobile();
  const { t } = useT();
  const [open, setOpen] = useState(false);

  if (!isMobile) return <>{children}</>;

  return (
    <>
      <div className="relative">
        {children}
        <div
          data-testid="mobile-expand-code-btn"
          className="absolute right-1.5 top-1.5 z-10 flex h-7 w-7 cursor-pointer items-center justify-center rounded-md bg-surface/80 text-t3 transition-colors hover:bg-s2 hover:text-t1 active:bg-s3"
          onClick={() => setOpen(true)}
          title={t("expand_fullscreen")}
        >
          <Icons.Expand />
        </div>
      </div>

      {open && (
        <div
          data-testid="mobile-code-fullscreen"
          className="glass-blur fixed inset-0 z-[600] flex flex-col bg-glass-bg"
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2.5">
            <div
              className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-[5px] text-t3 hover:bg-s2 hover:text-t1"
              onClick={() => setOpen(false)}
            >
              <span className="text-lg leading-none">←</span>
            </div>
            <div className="min-w-0 flex-1 truncate font-ui text-[calc(var(--ui-fs)+1px)] font-medium text-t1">
              {label || t("edit_field")}
            </div>
            <div
              className="flex h-8 cursor-pointer items-center justify-center rounded-md bg-accent px-4 font-ui text-[13px] font-medium text-on-accent transition-colors hover:bg-accent/90"
              onClick={() => setOpen(false)}
            >
              {t("done_btn")}
            </div>
          </div>
          {/* Inner scroll fullscreen: the session owns the whole viewport, so
              the scroller IS the natural mobile scroll region. */}
          <div className="min-h-0 flex-1 px-2 pb-2">
            <CodeEditor
              className="h-full"
              value={value}
              onChange={onChange}
              readOnly={readOnly}
              extensions={extensions}
            />
          </div>
        </div>
      )}
    </>
  );
}
