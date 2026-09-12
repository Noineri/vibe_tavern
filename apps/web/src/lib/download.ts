/**
 * Trigger a browser download of a `text` payload to a file.
 *
 * Shared by the character controller (card / VTF / markdown / jsonl / trace
 * exports) and the prompt manager (standalone regex JSON export, R-12) — both
 * used the same inline blob+anchor helper before this extraction.
 */
export function downloadTextFile(fileName: string, text: string, mimeType: string): void {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
