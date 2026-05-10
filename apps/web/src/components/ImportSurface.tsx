import type { ChangeEvent, DragEvent } from "react";
import { useT } from "../i18n/context.js";

interface ImportSurfaceProps {
  isImportDragActive: boolean;
  isImporting: boolean;
  importNotice: string;
  onDragOver: (event: DragEvent<HTMLLabelElement>) => void;
  onDragLeave: () => void;
  onDrop: (event: DragEvent<HTMLLabelElement>) => void;
  onFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
}

export function ImportSurface(input: ImportSurfaceProps) {
  const { t } = useT();
  return (
    <>
      <label
        className={`import-dropzone${input.isImportDragActive ? " is-drag-active" : ""}${input.isImporting ? " is-busy" : ""}`}
        onDragOver={input.onDragOver}
        onDragLeave={input.onDragLeave}
        onDrop={input.onDrop}
      >
        <input
          className="import-file-input"
          type="file"
          accept=".png,.json,image/png,application/json"
          onChange={input.onFileChange}
        />
        <div className="import-dropzone-title">
          {input.isImporting ? t("importing_file") : t("drop_png_json")}
        </div>
        <div className="import-dropzone-copy">
          {t("import_surface_desc")}
        </div>
      </label>
      {input.importNotice && <div className="import-notice">{input.importNotice}</div>}
    </>
  );
}
