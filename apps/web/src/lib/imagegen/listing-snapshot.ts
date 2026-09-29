/** IF-20: the fetch time of a listing the server answered from its
 *  last-good snapshot, for the «saved list» hints on both surfaces (the
 *  providers pane and the chat fine-tuning chip) — one formatter, two
 *  consumers. Short date + time in the browser's locale (the MessageShell
 *  timestamp precedent); an unparseable value renders verbatim. */
export function formatListingSnapshotTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString([], { dateStyle: "short", timeStyle: "short" });
}
