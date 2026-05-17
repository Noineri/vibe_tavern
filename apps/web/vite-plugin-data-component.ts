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

			// Strategy: find each exported component, locate its top-level return (JSX),
			// then inject data-component into the root JSX element.
			// We track brace depth to skip nested functions.

			const lines = code.split("\n");
			let modified = false;

			for (let i = 0; i < lines.length; i++) {
				const funcMatch = lines[i].match(
					/export\s+(?:default\s+)?function\s+([A-Z][A-Za-z0-9]*)\b/,
				);
				const constMatch = lines[i].match(
					/export\s+(?:const|let)\s+([A-Z][A-Za-z0-9]*)\s*=\s*(?:\([^)]*\)\s*(?:=>|:)|(?:\w+)\s*=>)/,
				);
				const componentName = funcMatch?.[1] ?? constMatch?.[1] ?? null;
				if (!componentName) continue;

				// Compute brace depth at end of the declaration line.
				// We want to track the function body depth so we can skip nested functions.
				let braceDepth = 0;
				for (const ch of lines[i]) {
					if (ch === "{") braceDepth++;
					if (ch === "}") braceDepth--;
				}
				const funcStartDepth = braceDepth;

				// Walk forward looking for the component's top-level return with JSX
				for (let j = i + 1; j < lines.length; j++) {
					for (const ch of lines[j]) {
						if (ch === "{") braceDepth++;
						if (ch === "}") braceDepth--;
					}

					// If we've closed the function body, stop looking
					if (braceDepth <= funcStartDepth - 1) break;

					const trimmed = lines[j].trim();

					// Only match top-level returns (depth === funcStartDepth)
					// and only if the line contains a `<` (JSX indicator)
					// or the next line does (multi-line return)
					if (!trimmed.startsWith("return")) continue;

					// Check that we're at the function's own depth (not inside a nested block)
					let lineDepth = 0;
					for (const ch of lines[j]) {
						if (ch === "{") lineDepth++;
						if (ch === "}") lineDepth--;
					}
					// The return must be at the same brace level as the function body
					// (funcStartDepth, not deeper from nested functions)
					// We check the depth *before* this line's braces
					let depthBeforeLine = braceDepth - lineDepth;
					if (depthBeforeLine !== funcStartDepth) continue;

					// Scan from this return line for a JSX tag
					for (let k = j; k < lines.length; k++) {
						const tagRegex = /(<[A-Za-z][A-Za-z0-9.-]*)([\s>\/])/g;
						let tagMatch: RegExpExecArray | null;

						while ((tagMatch = tagRegex.exec(lines[k])) !== null) {
							const matchIdx = tagMatch.index;
							const tagPart = tagMatch[1];

							if (tagPart.startsWith("</")) continue;

							// Skip anything that looks like a TS generic —
							// preceded by a non-JSX character (letter, closing paren, etc.)
							const charBefore = matchIdx > 0 ? lines[k][matchIdx - 1] : " ";
							// In real JSX, < is preceded by whitespace, (, {, =, !, or start of line
							// In TS generics, < is preceded by identifier chars, ), etc.
							if (/[A-Za-z0-9_)>]/.test(charBefore)) continue;

							const insertPos = matchIdx + tagPart.length;
							const attr = ` data-component="${componentName}"`;

							if (lines[k].substring(insertPos, insertPos + 20).includes("data-component")) break;

							lines[k] =
								lines[k].substring(0, insertPos) + attr + lines[k].substring(insertPos);
							modified = true;
							break;
						}

						if (modified) break;
					}

					break; // Only handle first top-level return
				}

				if (modified) break;
			}

			return modified ? lines.join("\n") : null;
		},
	};
}
