import { useRef, useState } from "react";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { useT } from "../../i18n/context.js";
import { cn } from "../../lib/cn.js";
import { Icons } from "./icons.js";

// Consumers: GalleryAccordion, ImportModals, PresetImportModal,
// LorebookImportModal, and AiAssistantModal.
export interface DropzoneProps {
  accept: string;
  multiple?: boolean;
  title: string;
  subtitle?: string;
  onFiles: (files: FileList) => void;
  size?: "default" | "compact";
  className?: string;
}

export function Dropzone({
  accept,
  multiple = false,
  title,
  subtitle,
  onFiles,
  size = "default",
  className,
}: DropzoneProps) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const isCompactDesktop = size === "compact" && !isMobile;
  const mobileTitle = t(multiple ? "dropzone_select_files" : "dropzone_select_file");

  const input = (
    <input
      ref={inputRef}
      className="hidden"
      type="file"
      accept={accept}
      multiple={multiple}
      onChange={(event) => {
        if (event.currentTarget.files) onFiles(event.currentTarget.files);
      }}
    />
  );

  if (isMobile) {
    return (
      <button
        type="button"
        className={cn(
          "flex cursor-pointer flex-col items-center gap-3 rounded-lg border-2 border-dashed px-5 py-10 font-ui text-t3 transition-all hover:border-accent hover:bg-s2 hover:text-t2",
          className,
        )}
        onClick={() => inputRef.current?.click()}
      >
        {input}
        <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-s3 text-t2 transition-all"><Icons.Import /></div>
        <div className="font-ui text-sm">{mobileTitle}</div>
      </button>
    );
  }

  return (
    <div
      className={cn(
        isCompactDesktop
          ? "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-6 transition-colors"
          : "flex cursor-pointer flex-col items-center gap-3 rounded-lg border-2 border-dashed px-5 py-10 font-ui text-t3 transition-all hover:border-accent hover:bg-s2 hover:text-t2",
        isCompactDesktop
          ? isDragging
            ? "border-accent bg-accent-dim/40"
            : "border-border bg-s2 hover:border-accent hover:bg-accent-dim/30"
          : isDragging && "border-accent bg-s2 text-t2",
        className,
      )}
      onDragOver={(event) => { event.preventDefault(); setIsDragging(true); }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setIsDragging(false);
        onFiles(event.dataTransfer.files);
      }}
      onClick={() => inputRef.current?.click()}
    >
      {input}
      {isCompactDesktop ? (
        <>
          <Icons.Import />
          <span className="font-ui text-[12px] text-t3">{title}</span>
        </>
      ) : (
        <>
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-s3 text-t2 transition-all"><Icons.Import /></div>
          <div className="font-ui text-sm">{title}</div>
          {subtitle && <div className="font-ui text-xs text-t4">{subtitle}</div>}
        </>
      )}
    </div>
  );
}
