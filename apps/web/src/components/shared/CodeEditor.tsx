import { useRef, useEffect, useCallback } from "react";
import { EditorView, basicSetup } from "codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { EditorState } from "@codemirror/state";

/** Theme matching RP Platform Espresso dark palette. */
const rpTheme = EditorView.theme(
  {
    "&": {
      fontSize: "12px",
      backgroundColor: "var(--bg)",
      color: "var(--t1)",
      borderRadius: "6px",
    },
    ".cm-content": {
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
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

const rpTokens = EditorView.baseTheme({
  "&dark .tok-keyword": { color: "var(--accent-t)" },
  "&dark .tok-string": { color: "oklch(0.72 0.10 145)" },
  "&dark .tok-number": { color: "oklch(0.75 0.12 70)" },
  "&dark .tok-comment": { color: "var(--t3)", fontStyle: "italic" },
  "&dark .tok-variableName": { color: "var(--t1)" },
  "&dark .tok-propertyName": { color: "oklch(0.78 0.08 200)" },
  "&dark .tok-operator": { color: "var(--t2)" },
  "&dark .tok-punctuation": { color: "var(--t3)" },
  "&dark .tok-bool": { color: "oklch(0.75 0.12 70)" },
  "&dark .tok-null": { color: "oklch(0.75 0.12 70)" },
  "&dark .tok-definition.variableName": { color: "var(--t1)" },
  "&dark .tok-function": { color: "oklch(0.78 0.10 150)" },
});

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
      rpTokens,
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
