/**
 * Split macro inner text by :: separator, then by ST's single-argument space
 * separator when no colon separator is present.
 * "setvar::x::hello world" → ["setvar", "x", "hello world"]
 * Also handles single : for legacy syntax: "random:a,b,c" → ["random", "a,b,c"]
 * Respects escaped colons \:
 */
export function splitMacroArgs(inner: string): string[] {
  const parts: string[] = [];
  let current = "";
  let i = 0;
  while (i < inner.length) {
    if (inner[i] === "\\" && i + 1 < inner.length && inner[i + 1] === ":") {
      current += ":";
      i += 2;
    } else if (inner[i] === ":" && i + 1 < inner.length && inner[i + 1] === ":") {
      parts.push(current.trim());
      current = "";
      i += 2;
    } else {
      current += inner[i];
      i++;
    }
  }
  // If we have accumulated content and there was a single : before it
  // (legacy format like "random:a,b,c")
  const trimmed = current.trim();
  // Check for legacy single-colon syntax: name:value
  if (parts.length === 0) {
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx > 0) {
      // "random:a,b,c" → ["random", "a,b,c"]
      // But only if the part before : looks like a macro name
      const possibleName = trimmed.slice(0, colonIdx).trim();
      if (/^[A-Za-z][A-Za-z0-9_]*$/.test(possibleName)) {
        return [possibleName, trimmed.slice(colonIdx + 1).trim()];
      }
    }
    const spaceMatch = trimmed.match(/^(\S+)\s+([\s\S]+)$/);
    if (spaceMatch) {
      return [spaceMatch[1], spaceMatch[2].trim()];
    }
  }
  parts.push(trimmed);
  return parts;
}
