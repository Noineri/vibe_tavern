import { useState, useCallback } from "react";
import { importJson } from "../app-client.js";
import { extractPngMetadata, parseCharacterMetadata } from "../lib/png-reader.js";

export interface CharacterImportOptions {
  chatId?: string;
}

export function useCharacterImport() {
  const [isImporting, setIsImporting] = useState(false);

  const importFile = useCallback(async (file: File, options?: CharacterImportOptions) => {
    setIsImporting(true);

    try {
      let payload: unknown;
      const lowerName = file.name.toLowerCase();

      if (file.type === "image/png" || lowerName.endsWith(".png")) {
        const metadata = await extractPngMetadata(file);
        payload = parseCharacterMetadata(metadata);
      } else if (file.type === "application/json" || lowerName.endsWith(".json")) {
        const text = await file.text();
        payload = JSON.parse(text);
      } else {
        throw new Error("Unsupported file type. Please upload a PNG character card or JSON file.");
      }

      return await importJson({
        fileName: file.name,
        jsonText: JSON.stringify(payload),
        chatId: options?.chatId,
      });
    } catch (err: unknown) {
      console.error("Import error:", err);
      const message = err instanceof Error ? err.message : "Failed to import character";
      throw new Error(message);
    } finally {
      setIsImporting(false);
    }
  }, []);

  return {
    importFile,
    isImporting,
  };
}
