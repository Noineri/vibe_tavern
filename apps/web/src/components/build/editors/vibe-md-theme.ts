/**
 * Vibe MD — CodeMirror 6 amber theme + syntax extensions.
 *
 * The visual surface of the Vibe MD editor (VTF-13 `VibeMdView`) and the
 * Co-Author read-only diff panel (CA-8 `CoAuthorEditor`). Pure presentation:
 * markdown syntax highlighting, the amber glow on H1 structural headings, a
 * read-only lock badge on every H1, and dimming of pseudo-code bracket traits
 * (`[Base: ...]`) so narrative prose reads at full brightness.
 *
 * Layering of heading protection (do not collapse — see VTF plan ADR):
 *  - **VTF-10 (this file): VISUAL.** H1 looks locked (amber glow + 🔒 badge).
 *    This is cosmetic only — it signals intent, it does not enforce anything.
 *  - **VTF-11 (`vibe-md-locked-headings.ts`): BEHAVIOURAL.** `changeFilter`
 *    blocks user input on heading lines (Threat 1 — accidental edits).
 *  - **VTF-12 (`vibe-md-sync.ts`): DATA.** parse→serialize structural pinning
 *    self-heals the canonical heading set against any source, including LLM
 *    Co-Author writes (Threat 2). Load-bearing; the only real guarantee.
 *
 * This module bundles the language + theme so VTF-13 composes a single
 * `vibeMdBundle()` into its editor. It does NOT import the storage codecs —
 * it is a pure editor surface and must stay UI-only.
 */

import { ViewPlugin, type ViewUpdate, EditorView, Decoration, type DecorationSet, WidgetType } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { markdown } from "@codemirror/lang-markdown";
import type { Extension, Range } from "@codemirror/state";

// ───────────────────────────────────────────────────────────────────────────
// Base editor chrome theme (font-body prose, accent cursor, line height)
// ───────────────────────────────────────────────────────────────────────────

const vibeMdBaseTheme = EditorView.theme(
  {
    "&": {
      fontSize: "calc(var(--ui-fs) + 1px)",
      backgroundColor: "transparent",
      color: "var(--t1)",
      borderRadius: "8px",
    },
    ".cm-content": {
      fontFamily: "'Inter', system-ui, sans-serif",
      caretColor: "var(--accent)",
      lineHeight: "1.7",
      padding: "10px 14px",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "var(--accent)",
      borderLeftWidth: "2px",
    },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "var(--accent-dim) !important",
    },
    ".cm-gutters": {
      backgroundColor: "transparent",
      color: "var(--t4)",
      border: "none",
      minWidth: "24px",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "transparent",
      color: "var(--t3)",
    },
    ".cm-activeLine": {
      backgroundColor: "color-mix(in srgb, var(--accent) 5%, transparent)",
    },
    ".cm-scroller": {
      fontFamily: "inherit",
      overflow: "auto",
    },
    ".cm-focused": {
      outline: "none",
    },
    // H1 structural-heading line: subtle amber wash + left accent rail.
    ".cm-vtf-h1-line": {
      backgroundColor: "color-mix(in srgb, var(--accent) 8%, transparent)",
      borderLeft: "2px solid var(--accent)",
      paddingLeft: "6px",
      marginLeft: "-8px",
      borderRadius: "2px",
    },
    // Amber glow on the heading text token itself (applied via highlight below).
    ".cm-vtf-h1-line .cm-header-1": {
      color: "var(--accent) !important",
      textShadow: "0 0 8px color-mix(in srgb, var(--accent) 45%, transparent)",
      fontWeight: "700",
    },
    // Lock badge rendered inline before each H1.
    ".cm-vtf-lock": {
      display: "inline-block",
      width: "12px",
      height: "12px",
      marginRight: "6px",
      verticalAlign: "-1px",
      opacity: "0.75",
      color: "var(--accent)",
    },
    // Dimmed pseudo-code bracket trait marker (e.g. `[Base: ...]`).
    ".cm-vtf-bracket": {
      color: "var(--t3)",
      fontStyle: "italic",
    },
  },
  { dark: true },
);

// ───────────────────────────────────────────────────────────────────────────
// Markdown syntax highlight style (amber headings, emphasis, lists, links)
// ───────────────────────────────────────────────────────────────────────────

const vibeMdHighlight = HighlightStyle.define([
  // Headings — H1 gets the amber glow via the line class; other headings tinted.
  { tag: tags.heading1, color: "var(--accent)", fontWeight: "700" },
  { tag: tags.heading2, color: "var(--accent-t)", fontWeight: "600" },
  { tag: tags.heading3, color: "var(--accent-t)", fontWeight: "600" },
  { tag: tags.heading4, color: "var(--t2)", fontWeight: "600" },
  { tag: tags.heading5, color: "var(--t2)", fontWeight: "600" },
  { tag: tags.heading6, color: "var(--t3)", fontWeight: "600" },
  // Inline emphasis — bold pops to primary, italic softens to secondary.
  { tag: tags.strong, color: "var(--t1)", fontWeight: "700" },
  { tag: tags.emphasis, color: "var(--t2)", fontStyle: "italic" },
  { tag: tags.strikethrough, color: "var(--t4)", textDecoration: "line-through" },
  // Links — accent for the URL, muted for the link text marker punctuation.
  { tag: tags.link, color: "var(--accent)" },
  { tag: tags.url, color: "var(--accent)" },
  // Lists / quotes — accent-t for bullets, t3 italic for blockquote prose.
  { tag: tags.list, color: "var(--accent-t)" },
  { tag: tags.quote, color: "var(--t3)", fontStyle: "italic" },
  // Inline code & code blocks — mono font, accent-tinted.
  { tag: tags.monospace, color: "var(--accent-t)", fontFamily: "var(--font-mono)" },
  // Fenced code block metadata (info string) and processing (frontmatter) — muted.
  { tag: tags.processingInstruction, color: "var(--t4)" },
  // Punctuation of markdown syntax (`#`, `**`, `>`, `[`, `]`) — dimmed so the
  // authored content dominates visually.
  { tag: tags.punctuation, color: "var(--t4)" },
  // Separators (horizontal rules) — accent rule.
  { tag: tags.separator, color: "var(--accent)" },
]);

// ───────────────────────────────────────────────────────────────────────────
// Lock-badge widget (inline icon before each structural H1)
// ───────────────────────────────────────────────────────────────────────────

/** Inline lock badge marking a heading as structurally read-only. */
class LockBadgeWidget extends WidgetType {
  constructor(readonly headingLabel: string) {
    super();
  }

  eq(other: LockBadgeWidget): boolean {
    return other.headingLabel === this.headingLabel;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-vtf-lock";
    span.setAttribute("aria-hidden", "true");
    span.title = `«${this.headingLabel}» — структурный заголовок (только для чтения)`;
    // Inline SVG lock — crisp at 12px, inherits currentColor (amber via the class).
    span.innerHTML =
      '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5 7V5a3 3 0 0 1 6 0v2"/></svg>';
    return span;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// H1 line decorations: amber line class + lock badge widget
// ───────────────────────────────────────────────────────────────────────────

/** Matches an H1 heading line: `# ` followed by a non-space (the canonical VTF body headings). */
const H1_LINE_RE = /^#\s+\S/;

function buildHeadingDecorations(view: EditorView): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos);
      const text = line.text;
      if (H1_LINE_RE.test(text)) {
        // Line styling: amber wash + left rail + heading glow (via the class).
        decorations.push(Decoration.line({ class: "cm-vtf-h1-line" }).range(line.from));
        // Lock badge widget, inserted before the `#` at the line start.
        const headingLabel = text.replace(/^#\s+/, "").trim();
        decorations.push(
          Decoration.widget({ widget: new LockBadgeWidget(headingLabel), side: -1 }).range(line.from),
        );
      }
      if (line.to >= to) break;
      pos = line.to + 1;
    }
  }
  // ` Decoration.set requires sorted ranges; line and widget decorations may
  // share a `from` — a stable sort by `from` keeps them adjacent and valid.
  return Decoration.set(decorations.sort((a, b) => a.from - b.from), true);
}

const headingPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildHeadingDecorations(view);
    }
    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged || update.transactions.some((t: { selection: unknown }) => t.selection)) {
        this.decorations = buildHeadingDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

// ───────────────────────────────────────────────────────────────────────────
// Bracket-trait decorations: dim pseudo-code markers like `[Base: ...]`
// ───────────────────────────────────────────────────────────────────────────

/**
 * Matches a bracket-trait marker `[Label: content]` where the content contains
 * no nested brackets. Trait labels start with an uppercase letter (e.g. `Base`,
 * `Appearance`, `Backstory`). Edge cases with nested brackets
 * (`[Active: [Tentacles]]`) are intentionally left un-matched and render as
 * normal narrative — dimming them would require bracket-balanced parsing for a
 * purely cosmetic effect, which is not worth the complexity.
 */
const BRACKET_TRAIT_RE = /\[[A-Z][A-Za-z]+:[^\[\]]*\]/g;

function buildBracketDecorations(view: EditorView): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.sliceDoc(from, to);
    BRACKET_TRAIT_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = BRACKET_TRAIT_RE.exec(text)) !== null) {
      const start = from + match.index;
      const end = start + match[0].length;
      decorations.push(Decoration.mark({ class: "cm-vtf-bracket" }).range(start, end));
    }
  }
  return Decoration.set(decorations.sort((a, b) => a.from - b.from), true);
}

const bracketPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildBracketDecorations(view);
    }
    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildBracketDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

// ───────────────────────────────────────────────────────────────────────────
// Bundle: the full editor surface (language + theme + decorations)
// ───────────────────────────────────────────────────────────────────────────

/**
 * The complete Vibe MD editor surface: markdown language, the amber base theme,
 * syntax highlighting, the H1 heading decorations (glow + lock badge), and the
 * bracket-trait dimming. Compose into a CodeMirror 6 `EditorState` extensions
 * array (VTF-13 `VibeMdView`, CA-8 `CoAuthorEditor`).
 *
 * Note: this bundle does NOT include `changeFilter` (VTF-11) or any sync logic
 * (VTF-12) — those are composed separately so the same theme renders correctly
 * in the read-only Co-Author panel (which has no input blocking and no sync).
 */
export function vibeMdBundle(): Extension[] {
  return [
    markdown(),
    vibeMdBaseTheme,
    syntaxHighlighting(vibeMdHighlight),
    headingPlugin,
    bracketPlugin,
    EditorView.lineWrapping,
  ];
}

/** The markdown language extension alone (for callers that compose their own theme). */
export const vibeMdLanguage = () => markdown();

/** The amber base theme + syntax highlight (for read-only surfaces that want the look). */
export const vibeMdThemeAndHighlight = (): Extension[] => [vibeMdBaseTheme, syntaxHighlighting(vibeMdHighlight)];
