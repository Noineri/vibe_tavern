import { javascript } from "@codemirror/lang-javascript";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { tags } from "@lezer/highlight";
import { EditorView, basicSetup } from "codemirror";
import { useCallback, useEffect, useRef } from "react";

/** Theme matching RP Platform Espresso dark palette. */
const rpTheme = EditorView.theme(
  {
    "&": {
      fontSize: "14px",
      backgroundColor: "var(--syn-bg)",
      color: "var(--t1)",
      borderRadius: "6px",
    },
    ".cm-content": {
      fontFamily: "var(--font-mono)",
      caretColor: "var(--accent)",
      lineHeight: "1.65",
      padding: "4px 0",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "var(--accent)",
      borderLeftWidth: "2px",
    },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      {
        backgroundColor: "var(--accent-dim) !important",
      },
    ".cm-gutters": {
      backgroundColor: "transparent",
      color: "var(--t3)",
      border: "none",
      minWidth: "28px",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "transparent",
      color: "var(--t2)",
    },
    ".cm-activeLine": {
      backgroundColor: "var(--accent-dim)",
    },
    ".cm-matchingBracket, .cm-nonmatchingBracket": {
      backgroundColor: "var(--accent-dim)",
      outline: "1px solid var(--accent)",
    },
    ".cm-foldPlaceholder": {
      backgroundColor: "var(--s3)",
      color: "var(--t3)",
      border: "none",
    },
    ".cm-scroller": {
      fontFamily: "inherit",
      overflow: "auto",
    },
    ".cm-focused": {
      outline: "none",
    },
  },
  { dark: true }
);

/** Syntax token colors matching Espresso palette. */
const pageScrollTheme = EditorView.theme({
  "&.cm-editor": {
    height: "auto",
  },
  ".cm-scroller": {
    overflow: "visible !important",
  },
  ".cm-gutters": {
    position: "static !important",
  },
});

const rpHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--syn-keyword)" },
  { tag: tags.string, color: "var(--syn-string)" },
  { tag: tags.number, color: "var(--syn-number)" },
  { tag: tags.comment, color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: tags.variableName, color: "var(--syn-variable)" },
  { tag: tags.propertyName, color: "var(--syn-property)" },
  { tag: tags.operator, color: "var(--syn-operator)" },
  { tag: tags.punctuation, color: "var(--syn-punctuation)" },
  { tag: tags.bool, color: "var(--syn-bool)" },
  { tag: tags.null, color: "var(--syn-null)" },
  { tag: tags.function(tags.variableName), color: "var(--syn-function)" },
  { tag: tags.definition(tags.variableName), color: "var(--syn-variable)" },
]);

interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  minHeight?: string;
  className?: string;
  readOnly?: boolean;
  scrollMode?: "inner" | "page";
}

export function CodeEditor({
  value,
  onChange,
  minHeight = "300px",
  className,
  readOnly = false,
  scrollMode = "inner",
}: CodeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const externalValueRef = useRef(value);

  const buildExtensions = useCallback(
    () => [
      basicSetup,
      javascript(),
      rpTheme,
      syntaxHighlighting(rpHighlight),
      ...(scrollMode === "page" ? [pageScrollTheme] : []),
      EditorView.lineWrapping,
      EditorState.readOnly.of(readOnly),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const doc = update.state.doc.toString();
          externalValueRef.current = doc;
          onChangeRef.current(doc);
        }
      }),
    ],
    [readOnly, scrollMode]
  );

  useEffect(() => {
    if (!containerRef.current) return;

    viewRef.current?.destroy();

    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: buildExtensions(),
      }),
      parent: containerRef.current,
    });
    viewRef.current = view;
    externalValueRef.current = value;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildExtensions]);

  // Sync external value into editor without clobbering cursor
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const currentDoc = view.state.doc.toString();
    if (currentDoc !== value) {
      externalValueRef.current = value;
      view.dispatch({
        changes: { from: 0, to: currentDoc.length, insert: value },
      });
    }
  }, [value]);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ minHeight, overflow: scrollMode === "page" ? "visible" : "auto" }}
    />
  );
}
