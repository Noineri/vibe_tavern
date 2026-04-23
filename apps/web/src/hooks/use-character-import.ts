import { useState, useCallback } from 'react';
import { extractPngMetadata, parseCharacterMetadata } from '../lib/png-reader.js';

export interface CharacterImportOptions {
  chatId?: string;
}

export function useCharacterImport() {
  const [isImporting, setIsImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const importFile = useCallback(async (file: File, options?: CharacterImportOptions) => {
    setIsImporting(true);
    setError(null);

    try {
      let payload: any;
      const lowerName = file.name.toLowerCase();

      if (file.type === 'image/png' || lowerName.endsWith('.png')) {
        // Extract from PNG
        const metadata = await extractPngMetadata(file);
        payload = parseCharacterMetadata(metadata);
      } else if (file.type === 'application/json' || lowerName.endsWith('.json')) {
        // Direct JSON
        const text = await file.text();
        payload = JSON.parse(text);
      } else {
        throw new Error('Unsupported file type. Please upload a PNG character card or JSON file.');
      }

      // Send to the backend import endpoint
      const response = await fetch('/api/import/json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: file.name,
          jsonText: JSON.stringify(payload),
          chatId: options?.chatId,
        }),
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Failed to import character');
      }

      const result = await response.json();
      return result;
    } catch (err: unknown) {
      console.error('Import error:', err);
      const message = err instanceof Error ? err.message : 'Failed to import character';
      setError(message);
      throw new Error(message);
    } finally {
      setIsImporting(false);
    }
  }, []);

  return {
    importFile,
    isImporting,
    error,
  };
}
