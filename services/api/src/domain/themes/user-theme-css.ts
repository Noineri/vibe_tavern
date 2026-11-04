import { parse as parseStylesheet, type Rule, type Document } from "postcss";
import { parse as parseSelector, walk, type CssNode } from "css-tree";
import { validation } from "../../shared/errors.js";

function isRoot(node: CssNode | undefined): boolean {
  return node?.type === "PseudoClassSelector" && node.name.toLowerCase() === "root" && node.children === null;
}

/** PostCSS handles CSS nesting; CSS Tree parses only selectors, with source locations. */
export function normalizeUserThemeCss(css: string, slug: string): string {
  let normalized: string;
  let hasRootTokens = false;
  try {
    const ast = parseStylesheet(css, { from: undefined });
    ast.walkRules((rule) => {
      let parent: Rule["parent"] | Document = rule.parent;
      while (parent) {
        if (parent.type === "atrule" && /keyframes$/i.test(parent.name)) return;
        parent = parent.parent;
      }
      const selectors = parseSelector(rule.selector, { context: "selectorList", positions: true, onParseError(error) { throw error; } });
      if (selectors.type !== "SelectorList") return;
      if (rule.parent?.type === "root" && rule.nodes.some((node) => node.type === "decl" && node.prop.startsWith("--"))) {
        hasRootTokens ||= selectors.children.some((selector) => {
          if (selector.type !== "Selector") return false;
          const parts = selector.children.toArray();
          return isRoot(parts[0]) && (parts.length === 1 || (parts.length === 2 && parts[1].type === "ClassSelector"));
        });
      }
      const edits: Array<{ start: number; end: number; text: string }> = [];
      walk(selectors, {
        visit: "PseudoClassSelector",
        enter(node, item) {
          if (!isRoot(node) || !node.loc) return;
          const next = item?.next?.data;
          const named = next?.type === "ClassSelector" && next.loc;
          edits.push({ start: node.loc.start.offset, end: node.loc.end.offset, text: named ? ":root" : `:root.user-${slug}` });
          if (named) edits.push({ start: named.start.offset, end: named.end.offset, text: `.user-${slug}` });
        },
      });
      let selector = rule.selector;
      for (const edit of edits.sort((a, b) => b.start - a.start)) selector = selector.slice(0, edit.start) + edit.text + selector.slice(edit.end);
      rule.selector = selector;
    });
    normalized = ast.toString();
  } catch {
    throw validation("Invalid CSS. Expected a theme with a :root { --bg: ...; } rule.", { code: "invalid-css" });
  }
  if (!hasRootTokens) throw validation("Expected CSS custom properties in a top-level :root or :root.theme rule (for example :root { --bg: #141210; }).", { code: "missing-root" });
  return normalized;
}
