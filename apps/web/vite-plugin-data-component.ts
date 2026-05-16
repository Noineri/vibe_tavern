/**
 * Vite plugin: data-component
 *
 * Adds `data-component="ComponentName"` to the root JSX element of every
 * React component in development mode. Shows up in the browser's Elements
 * panel for easy debugging.
 *
 * Production builds are unaffected (plugin disables itself via configResolved).
 */

import type { Plugin } from "vite";

export function dataComponentPlugin(): Plugin {
	let enabled = false;

	return {
		name: "vite-plugin-data-component",
		enforce: "pre",

		configResolved(config) {
			enabled = config.command === "serve";
		},

		transform(code: string, id: string) {
			if (!enabled) return null;
			if (!id.endsWith(".tsx") && !id.endsWith(".jsx")) return null;
			if (id.includes("node_modules")) return null;
			if (id.includes(".test.")) return null;

			if (
				!code.includes("export function") &&
				!code.includes("export const") &&
				!code.includes("export default function")
			) {
				return null;
			}

			const lines = code.split("\n");
			let modified = false;
			let componentName: string | null = null;
			let braceDepth = 0;
			let funcBraceDepth = -1;
			let pendingInject = false;

			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				const trimmed = line.trim();

				for (const ch of line) {
					if (ch === "{") braceDepth++;
					if (ch === "}") braceDepth--;
				}

				// Detect: export function ComponentName
				const funcMatch = line.match(
					/export\s+(?:default\s+)?function\s+([A-Z][A-Za-z0-9]*)\b/,
				);
				// Detect: export const ComponentName = (...) => or () =>
				const constMatch = line.match(
					/export\s+(?:const|let)\s+([A-Z][A-Za-z0-9]*)\s*=\s*(?:\([^)]*\)\s*(?:=>|:)|(?:\w+)\s*=>)/,
				);

				if (funcMatch) {
					componentName = funcMatch[1];
					funcBraceDepth = braceDepth;
					pendingInject = false;
				} else if (constMatch) {
					componentName = constMatch[1];
					funcBraceDepth = braceDepth;
					pendingInject = false;
				}

				// Detect return statement
				if (componentName && funcBraceDepth >= 0 && !pendingInject) {
					if (trimmed.startsWith("return")) {
						pendingInject = true;
					}
				}

				// Find first genuine JSX tag and inject data-component
				if (pendingInject && componentName) {
					// Match <Tagname followed by space, >, or /
					// Captures just the "<Tagname" part for precise insertion
					const tagRegex = /(<[A-Za-z][A-Za-z0-9.-]*)([\s>\/])/g;
					let tagMatch: RegExpExecArray | null;

					while ((tagMatch = tagRegex.exec(line)) !== null) {
						const matchIdx = tagMatch.index;
						const tagPart = tagMatch[1]; // "<div"

						// Check the character before < to exclude TypeScript generics.
						// In TS, generics appear after : , > | & (type separators).
						// In JSX, < appears after whitespace, (, {, =, or at start of line.
						const charBefore = matchIdx > 0 ? line[matchIdx - 1] : " ";
						if (":,>|&".includes(charBefore)) continue;

						// Skip closing tags
						if (tagPart.startsWith("</")) continue;

						// Insert data-component attribute right after the tag name
						const insertPos = matchIdx + tagPart.length;
						const attr = ` data-component="${componentName}"`;

						// Don't inject twice
						if (
							line.substring(insertPos, insertPos + attr.length + 5).includes("data-component")
						) {
							break;
						}

						lines[i] =
							line.substring(0, insertPos) + attr + line.substring(insertPos);
						modified = true;
						pendingInject = false;
						componentName = null;
						break;
					}
				}

				// Reset when leaving the function
				if (funcBraceDepth >= 0 && braceDepth < funcBraceDepth) {
					componentName = null;
					funcBraceDepth = -1;
					pendingInject = false;
				}
			}

			return modified ? lines.join("\n") : null;
		},
	};
}
