interface MdastPosition {
  start: { offset?: number };
  end: { offset?: number };
}

interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
  position?: MdastPosition;
  compatibilityTag?: boolean;
}

interface HastText {
  type: "text";
  value: string;
}

interface HastElement {
  type: "element";
  children: HastNode[];
}

interface HastRoot {
  type: "root";
  children: HastNode[];
}

type HastNode = HastText | HastElement | HastRoot;

const ESCAPED_TAG_TOKEN_RE = /\uE000vt-escaped-tag:([^\uE001]+)\uE001/g;

function isAsciiLetter(value: string): boolean {
  const code = value.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isTagNameChar(value: string): boolean {
  const code = value.charCodeAt(0);
  return isAsciiLetter(value) || (code >= 48 && code <= 57) || value === ":" || value === "_" || value === "-";
}

function hasUnderscoreTagName(tag: string): boolean {
  let cursor = tag.startsWith("/") ? 1 : 0;
  if (!isAsciiLetter(tag[cursor] ?? "")) return false;

  const nameStart = cursor;
  while (cursor < tag.length && isTagNameChar(tag[cursor]!)) cursor += 1;
  return tag.slice(nameStart, cursor).includes("_");
}

function isText(node: HastNode): node is HastText {
  return node.type === "text";
}

function isContainer(node: HastNode): node is HastElement | HastRoot {
  return node.type === "element" || node.type === "root";
}

/** Scan tags linearly so malformed model output cannot trigger regex backtracking. */
function findUnderscoreTags(source: string): string[] {
  const tags: string[] = [];
  let cursor = 0;

  while (cursor < source.length) {
    const start = source.indexOf("<", cursor);
    if (start === -1) break;

    let tagCursor = start + 1;
    if (source[tagCursor] === "/") tagCursor += 1;
    const nameStart = tagCursor;
    if (!isAsciiLetter(source[tagCursor] ?? "")) {
      cursor = start + 1;
      continue;
    }

    while (tagCursor < source.length && isTagNameChar(source[tagCursor]!)) tagCursor += 1;
    if (!source.slice(nameStart, tagCursor).includes("_")) {
      cursor = tagCursor;
      continue;
    }

    let quote = "";
    while (tagCursor < source.length) {
      const character = source[tagCursor]!;
      if (quote) {
        if (character === quote) quote = "";
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === ">") {
        tags.push(source.slice(start, tagCursor + 1));
        cursor = tagCursor + 1;
        break;
      }
      tagCursor += 1;
    }

    if (tagCursor === source.length) break;
  }

  return tags;
}

function normalizeUnderscoreTag(tag: string): string {
  return tag.replace(/^(<\/?)([A-Za-z][A-Za-z0-9:_-]*)/, (_, prefix: string, name: string) => `${prefix}${name.replaceAll("_", "-")}`);
}

interface EscapedAngle {
  character: "<" | ">";
  length: number;
}

function readEscapedAngle(source: string, start: number): EscapedAngle | null {
  const character = source[start];
  if (character === "\\" && (source[start + 1] === "<" || source[start + 1] === ">")) {
    return { character: source[start + 1] as "<" | ">", length: 2 };
  }

  if (character !== "&") return null;
  const semicolon = source.indexOf(";", start + 1);
  if (semicolon === -1 || semicolon - start > 10) return null;

  const entity = source.slice(start + 1, semicolon);
  if (entity.toLowerCase() === "lt") return { character: "<", length: semicolon - start + 1 };
  if (entity.toLowerCase() === "gt") return { character: ">", length: semicolon - start + 1 };
  if (!entity.startsWith("#")) return null;

  const radix = entity[1]?.toLowerCase() === "x" ? 16 : 10;
  const digits = entity.slice(radix === 16 ? 2 : 1);
  if (!digits || ![...digits].every((digit) => radix === 16 ? /[0-9a-f]/i.test(digit) : /[0-9]/.test(digit))) return null;

  const codePoint = Number.parseInt(digits, radix);
  if (codePoint === 60) return { character: "<", length: semicolon - start + 1 };
  if (codePoint === 62) return { character: ">", length: semicolon - start + 1 };
  return null;
}

function findExplicitTagEnd(source: string, start: number): { start: number; end: number } | null {
  let quote = "";

  for (let cursor = start; cursor < source.length; cursor += 1) {
    const character = source[cursor]!;
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === ">") return { start: cursor, end: cursor + 1 };

    const escaped = readEscapedAngle(source, cursor);
    if (escaped?.character === ">") return { start: cursor, end: cursor + escaped.length };
    if (escaped) cursor += escaped.length - 1;
  }

  return null;
}

export function preserveEscapedUnderscoreTags(source: string): string {
  let result = "";
  let cursor = 0;
  let copiedUntil = 0;

  while (cursor < source.length) {
    const escaped = readEscapedAngle(source, cursor);
    if (escaped?.character !== "<") {
      cursor += escaped?.length ?? 1;
      continue;
    }

    const end = findExplicitTagEnd(source, cursor + escaped.length);
    if (!end) break;
    const tag = source.slice(cursor + escaped.length, end.start);
    if (!hasUnderscoreTagName(tag)) {
      cursor += escaped.length;
      continue;
    }

    result += source.slice(copiedUntil, cursor);
    result += `\uE000vt-escaped-tag:${tag}\uE001`;
    cursor = end.end;
    copiedUntil = cursor;
  }

  return result + source.slice(copiedUntil);
}

/**
 * CommonMark parses underscore-bearing XML-like tags as text, unlike ordinary
 * custom tags. Reclassify only literal source tags as raw HTML, using a
 * hyphenated parser surrogate. Rehype then applies the existing sanitizer,
 * which unwraps unsupported custom elements without allowing them.
 */
export function remarkUnderscoreCustomTags() {
  return (tree: MdastNode, file: { value?: unknown }) => {
    const sourceValue = file.value;
    if (typeof sourceValue !== "string") return;

    const visit = (node: MdastNode): void => {
      if (node.type === "code" || node.type === "inlineCode" || node.type === "html") return;

      if (node.children) {
        node.children = node.children.flatMap((child) => {
          visit(child);
          if (child.type === "paragraph" && child.children?.length === 1 && child.children[0]?.compatibilityTag) {
            return { ...child.children[0], position: child.position };
          }

          const start = child.position?.start.offset;
          const end = child.position?.end.offset;
          const source = start === undefined || end === undefined ? undefined : sourceValue.slice(start, end);
          if (child.type !== "text" || typeof child.value !== "string" || !source) return child;

          const replacements: MdastNode[] = [];
          let textOffset = 0;
          let changed = false;
          for (const tag of findUnderscoreTags(source)) {
            const tagOffset = child.value.indexOf(tag, textOffset);
            if (tagOffset === -1) continue;
            if (tagOffset > textOffset) replacements.push({ type: "text", value: child.value.slice(textOffset, tagOffset) });
            replacements.push({ type: "html", value: normalizeUnderscoreTag(tag), compatibilityTag: true });
            textOffset = tagOffset + tag.length;
            changed = true;
          }

          if (!changed) return child;
          if (textOffset < child.value.length) replacements.push({ type: "text", value: child.value.slice(textOffset) });
          return replacements;
        });
      }
    };

    visit(tree);
  };
}

function restoreEscapedUnderscoreTags(node: HastNode): void {
  if (isText(node)) {
    node.value = node.value.replace(ESCAPED_TAG_TOKEN_RE, (token: string, tag: string) => hasUnderscoreTagName(tag) ? `<${tag}>` : token);
    return;
  }

  if (isContainer(node)) {
    for (const child of node.children) restoreEscapedUnderscoreTags(child);
  }
}

export const rehypeRestoreEscapedUnderscoreTags = () => (tree: HastNode) => restoreEscapedUnderscoreTags(tree);
