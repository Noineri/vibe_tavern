import { useEffect, useRef, useState } from "react";
import { Icons } from "./icons.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { useT } from "../../i18n/context.js";

interface MobileExpandTextareaProps {
  /** Current text value (for the fullscreen editor) */
  value: string;
  /** Called when fullscreen editor changes text */
  onChange: (value: string) => void;
  /** Label shown in fullscreen header */
  label?: string;
  /** The inline textarea element to wrap */
  children: React.ReactNode;
}

/**
 * Wraps a textarea. On mobile, overlays an expand button in the top-right corner.
 * Tapping it opens a fullscreen editor with the full text.
 * Desktop: renders children unchanged.
 */
export function MobileExpandTextarea({
  value, onChange, label, children,
}: MobileExpandTextareaProps) {
  const isMobile = useIsMobile();
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const fsRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { if (open) { setDraft(value); fsRef.current?.focus(); } }, [open, value]);

  const handleDone = () => {
    onChange(draft);
    setOpen(false);
  };

  if (!isMobile) return <>{children}</>;

  return (
    <>
      <div className="relative">
        {children}
        <div
          className="absolute right-1.5 top-1.5 flex h-7 w-7 cursor-pointer items-center justify-center rounded-md bg-surface/80 text-t3 transition-colors hover:bg-s2 hover:text-t1 active:bg-s3"
          onClick={() => setOpen(true)}
          title={t("expand_fullscreen")}
        >
          <Icons.Expand />
        </div>
      </div>

      {open && (
        <div className="fixed inset-0 z-[600] flex flex-col bg-surface">
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
              onClick={handleDone}
            >
              {t("done_btn")}
            </div>
          </div>
          <textarea
            ref={fsRef}
            className="flex-1 resize-none border-0 bg-transparent px-4 py-3 font-ui text-t1 outline-none placeholder:text-t4"
            style={{ fontSize: 'var(--ui-fs)', lineHeight: 1.6 }}
            value={draft}
            onChange={e => setDraft(e.target.value)}
          />
        </div>
      )}
    </>
  );
}
