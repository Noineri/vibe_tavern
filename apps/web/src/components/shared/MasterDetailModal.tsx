import { type ReactNode, createContext, useContext, useState, useEffect } from "react";
import { cn } from "../../lib/cn.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { useT } from "../../i18n/context.js";
import { Modal } from "./Modal.js";
import { Icons } from "./icons.js";
import { CustomTooltip } from "./Tooltip.js";
import { SegmentedControl } from "./SegmentedControl.js";

interface MasterDetailContextValue {
  isMobile: boolean;
  isDetailOpen: boolean;
  openDetail: () => void;
  closeDetail: () => void;
}

const MasterDetailContext = createContext<MasterDetailContextValue | null>(null);

export function useMasterDetail() {
  const ctx = useContext(MasterDetailContext);
  if (!ctx) throw new Error("useMasterDetail must be used within MasterDetailModal");
  return ctx;
}

export function MasterDetailMobileDrillDown({ onSelect, className }: { onSelect?: () => void; className?: string }) {
  const { openDetail } = useMasterDetail();
  return (
    <button
      type="button"
      className={cn("shrink-0 px-2 text-t3 transition-colors hover:text-t1 md:hidden", className)}
      onClick={(e) => { 
        e.stopPropagation(); 
        if (onSelect) onSelect(); 
        openDetail(); 
      }}
    >
      <Icons.Caret direction="r" />
    </button>
  );
}

/** Optional segmented tabs docked at the bottom of the modal header.
 *  Generic over the tab-id union so consumers pass their `Tab` type straight
 *  through with no casts. Rendered as a `SegmentedControl`; on mobile it stays
 *  on the main (non-drill-down) header, exactly like hand-placed header tabs. */
export interface MasterDetailModalTabs<T extends string = string> {
  items: Array<{ value: T; label: ReactNode; disabled?: boolean; tooltip?: ReactNode }>;
  active: T;
  onChange: (value: T) => void;
}

export interface MasterDetailFooterAction {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}

export function MasterDetailFooter({
  actions = [],
  onClose,
  right,
}: {
  actions?: MasterDetailFooterAction[];
  onClose?: () => void;
  right?: ReactNode;
}) {
  const isMobile = useIsMobile();
  const { t } = useT();
  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-2.5 border-t border-border",
        isMobile ? "flex-wrap px-3 py-2.5" : "py-3.5 px-5",
      )}
    >
      {actions.map((a) =>
        isMobile ? (
          <button
            key={a.label}
            type="button"
            className="flex h-9 w-9 items-center justify-center rounded-md bg-s3 text-t3 active:bg-s2"
            onClick={a.onClick}
            aria-label={a.label}
          >
            {a.icon}
          </button>
        ) : (
          <span
            key={a.label}
            className="flex cursor-pointer items-center gap-1 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-all hover:text-t1"
            onClick={a.onClick}
          >
            {a.icon} {a.label}
          </span>
        ),
      )}
      <div className="ml-auto flex min-w-0 items-center gap-2.5">
        {!isMobile && onClose && (
          <button
            type="button"
            className="h-[37px] cursor-pointer rounded-md border border-border bg-surface py-0 px-[21px] font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-t2 transition-all hover:bg-s2 hover:text-t1"
            onClick={onClose}
          >
            {t("close")}
          </button>
        )}
        {right}
      </div>
    </div>
  );
}

export interface MasterDetailModalProps<T extends string = string> {
  isOpen: boolean;
  onClose: () => void;

  /** The global modal title. */
  title: ReactNode;
  /** Subtitle below the title (desktop only). */
  subtitle?: ReactNode;
  /** Mobile drill-down header title. Defaults to `title`. */
  detailTitle?: ReactNode;
  /** Extra buttons to place next to the close icon on the desktop header and mobile main header. */
  headerActions?: ReactNode;
  /** Extra content to place at the very bottom of the global header. For plain
   *  segmented tabs prefer the declarative `tabs` prop instead. */
  headerBottom?: ReactNode;
  /** Segmented tabs docked at the bottom of the global header (desktop and
   *  mobile main view). Optional — omit for tab-less master-detail modals. */
  tabs?: MasterDetailModalTabs<T>;
  /** Shows an unsaved orange dot next to the title. */
  dirty?: boolean;

  /** Content for the left column (list). Can be a render prop to access openDetail. */
  masterContent: ReactNode | ((ctx: { openDetail: () => void }) => ReactNode);
  /** Content for the right column (editor). */
  detailContent: ReactNode | ((ctx: { closeDetail: () => void }) => ReactNode);

  /** The global footer. On desktop: spans full width. On mobile: visible only when isDetailOpen = true. */
  footer?: ReactNode;

  /** Hook for when user clicks back on mobile */
  onBack?: () => void;

  /** CSS classes for the outermost container on desktop. (On mobile, it's always full screen). */
  containerClassName?: string;
  /** CSS classes for the master (left) column wrapper on desktop. */
  masterClassName?: string;
  /** CSS classes for the detail (right) column wrapper on desktop. */
  detailClassName?: string;
  /** CSS classes for the detail column wrapper on mobile. Defaults to "p-4". */
  mobileDetailClassName?: string;
  /** CSS classes for the desktop header wrapper. */
  headerClassName?: string;
}

export function MasterDetailModal<T extends string = string>({
  isOpen,
  onClose,
  title,
  subtitle,
  detailTitle,
  headerActions,
  headerBottom,
  tabs,
  dirty,
  masterContent,
  detailContent,
  footer,
  onBack,
  containerClassName = "max-h-[calc(100vh-60px)] max-w-[calc(100vw-32px)] h-[680px] w-[860px] rounded-xl border border-border2 shadow-[0_24px_60px_rgba(0,0,0,.5)]",
  masterClassName = "flex w-[220px] shrink-0 flex-col border-r border-border",
  detailClassName = "p-6",
  mobileDetailClassName = "p-4",
  headerClassName,
}: MasterDetailModalProps<T>) {
  const isMobile = useIsMobile();
  const { t } = useT();
  const [isDetailOpen, setIsDetailOpen] = useState(false);

  // Reset drill-down state when modal closes
  useEffect(() => {
    if (!isOpen) {
      setIsDetailOpen(false);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleBack = () => {
    setIsDetailOpen(false);
    if (onBack) onBack();
  };

  const desktopHeader = (
    <div className={cn("shrink-0 border-b border-border", headerClassName || (isMobile ? "px-3 py-2.5" : "px-6 pt-5"))}>
      <div className={cn("flex items-start justify-between", !isMobile && !headerBottom && !tabs && !headerClassName && "pb-4")}>
        <div>
          <div className={cn("font-body font-semibold text-t1", isMobile ? "text-[calc(var(--ui-fs)+2px)]" : "text-[18px] mb-1")}>
            {title}
            {dirty && (
              <CustomTooltip content={t("unsaved_changes_title")}>
                <span className="ml-1.5 inline-block h-[7px] w-[7px] shrink-0 rounded-full bg-accent align-middle" />
              </CustomTooltip>
            )}
          </div>
          {!isMobile && subtitle && (
            <div className="font-ui text-[13px] text-t3">{subtitle}</div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {headerActions}
          <button
            type="button"
            className={cn(
              "flex shrink-0 cursor-pointer items-center justify-center text-t3 transition-colors",
              isMobile ? "h-10 w-10 rounded-lg active:bg-s2" : "h-8 w-8 rounded-md hover:bg-s2 hover:text-t1"
            )}
            onClick={onClose}
          >
            <Icons.Close />
          </button>
        </div>
      </div>
      {headerBottom}
      {tabs && (
        <div className="mt-3">
          <SegmentedControl value={tabs.active} options={tabs.items} onChange={tabs.onChange} />
        </div>
      )}
    </div>
  );

  const mobileDrillHeader = (
    <div className="shrink-0 border-b border-border px-3 py-2.5">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-lg text-t3 active:bg-s2 transition-colors hover:bg-s2 hover:text-t1"
          onClick={handleBack}
        >
          <Icons.Caret direction="l" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate font-body text-[calc(var(--ui-fs)+2px)] font-medium text-t1">
            {detailTitle ?? title}
          </div>
        </div>
        <button
          type="button"
          className="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-lg text-t3 active:bg-s2 transition-colors hover:bg-s2 hover:text-t1"
          onClick={onClose}
        >
          <Icons.Close />
        </button>
      </div>
    </div>
  );

  return (
    <Modal open={isOpen} onClose={onClose}>
      <MasterDetailContext.Provider
        value={{
          isMobile,
          isDetailOpen,
          openDetail: () => setIsDetailOpen(true),
          closeDetail: () => setIsDetailOpen(false),
        }}
      >
        <div
          className={cn(
            // Frost UNDER the content (R-8): any non-none backdrop-filter on
            // the panel — even blur(0) in opaque themes — makes the panel a
            // containing block for position:fixed descendants, so dnd-kit's
            // DragOverlay (fixed, rendered inline in the panel tree) resolved
            // against the panel box and appeared offset right/down of the
            // cursor in every master-detail list. .glass-blur-under moves the
            // fill + frost to a z:-1 ::before underlayer — same frost rect and
            // look, panel itself keeps backdrop-filter: none. Opaque themes
            // remain byte-identical (--glass-bg == --surface, blur 0).
            "glass-blur-under flex flex-col overflow-hidden",
            isMobile ? "h-[100dvh] w-[100dvw]" : containerClassName,
          )}
          onClick={(e) => e.stopPropagation()}
        >
          {/* HEADER SECTION */}
          {isMobile ? (isDetailOpen ? mobileDrillHeader : desktopHeader) : desktopHeader}

          {/* BODY SECTION */}
          <div className="flex min-h-0 flex-1">
            {(!isMobile || !isDetailOpen) && (
              <div className={cn("flex flex-col min-h-0", isMobile ? "w-full" : masterClassName)}>
                {typeof masterContent === "function" ? masterContent({ openDetail: () => setIsDetailOpen(true) }) : masterContent}
              </div>
            )}
            {(!isMobile || isDetailOpen) && (
              <div className={cn("min-w-0 flex-1 overflow-y-auto", isMobile ? mobileDetailClassName : detailClassName)}>
                {typeof detailContent === "function" ? detailContent({ closeDetail: () => setIsDetailOpen(false) }) : detailContent}
              </div>
            )}
          </div>

          {/* FOOTER SECTION */}
          {(!isMobile || isDetailOpen) && footer}
        </div>
      </MasterDetailContext.Provider>
    </Modal>
  );
}
