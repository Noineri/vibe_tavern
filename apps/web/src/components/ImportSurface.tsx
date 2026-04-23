import type { ChangeEvent, DragEvent } from "react";

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
          {input.isImporting ? "Importing file..." : "Drop PNG or JSON here or click to choose a file"}
        </div>
        <div className="import-dropzone-copy">
          PNG or JSON character cards create a new chat. Lorebook JSON attaches to the current character.
        </div>
      </label>
      {input.importNotice && <div className="import-notice">{input.importNotice}</div>}
    </>
  );
}
