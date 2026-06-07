import { type ReactNode } from "react";
import { cn } from "../../lib/cn.js";

export interface MasterDetailLayoutProps {
  /** True if the device is mobile (e.g. from useIsMobile hook). */
  isMobile: boolean;
  /** True if the drill-down detail view is currently active on mobile. Ignored on desktop. */
  isDetailOpen: boolean;

  /** The global header. On desktop: spans full width. On mobile: visible only when isDetailOpen = false. */
  header?: ReactNode;
  /** The mobile detail header (usually with a Back button). Visible only on mobile when isDetailOpen = true. */
  mobileDetailHeader?: ReactNode;

  /** Content for the left column (list). */
  masterContent: ReactNode;
  /** Content for the right column (editor). */
  detailContent: ReactNode;

  /** The global footer. On desktop: spans full width. On mobile: visible only when isDetailOpen = true. */
  footer?: ReactNode;

  /** CSS classes for the outermost container on desktop. (On mobile, it's always h-full w-full). */
  containerClassName?: string;
  /** CSS classes for the master (left) column wrapper on desktop. */
  masterClassName?: string;
  /** CSS classes for the detail (right) column wrapper on desktop. */
  detailClassName?: string;
}

export function MasterDetailLayout({
  isMobile,
  isDetailOpen,
  header,
  mobileDetailHeader,
  masterContent,
  detailContent,
  footer,
  containerClassName,
  masterClassName,
  detailClassName,
}: MasterDetailLayoutProps) {
  return (
    <div
      className={cn(
        "flex flex-col overflow-hidden bg-surface",
        isMobile ? "h-full w-full" : containerClassName,
      )}
      onClick={(e) => e.stopPropagation()}
    >
      {/* HEADER SECTION */}
      {isMobile ? (isDetailOpen ? mobileDetailHeader : header) : header}

      {/* BODY SECTION */}
      <div className="flex min-h-0 flex-1">
        {(!isMobile || !isDetailOpen) && (
          <div className={cn("flex flex-col min-h-0", isMobile ? "w-full" : masterClassName)}>
            {masterContent}
          </div>
        )}
        {(!isMobile || isDetailOpen) && (
          <div className={cn("flex min-w-0 flex-1 flex-col overflow-y-auto", detailClassName)}>
            {detailContent}
          </div>
        )}
      </div>

      {/* FOOTER SECTION */}
      {(!isMobile || isDetailOpen) && footer}
    </div>
  );
}
