import { PresetImportModal, type PresetImportResult } from "./PresetImportModal.js";

interface PresetImportModalHostProps {
  file: File | null | undefined;
  onClose: () => void;
  onImport: (result: PresetImportResult) => void;
}

export function PresetImportModalHost({ file, onClose, onImport }: PresetImportModalHostProps) {
  if (file === undefined) return null;

  return (
    <PresetImportModal
      initialFile={file ?? undefined}
      onClose={onClose}
      onImport={onImport}
    />
  );
}
