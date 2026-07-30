export function transformDataComponent(
	code: string,
	id: string,
	enabled: boolean,
): string | null {
	if (!enabled) return null;
	if (!id.endsWith(".tsx") && !id.endsWith(".jsx")) return null;
	if (id.includes("node_modules") || id.includes(".test.")) return null;
	if (
		!code.includes("export function") &&
		!code.includes("export const") &&
		!code.includes("export default function")
	) {
		return null;
	}

	const lines = code.split("\n");
	let modified = false;

	for (let i = 0; i < lines.length; i++) {
		const functionMatch = lines[i].match(
			/export\s+(?:default\s+)?function\s+([A-Z][A-Za-z0-9]*)\b/,
		);
		const constantMatch = lines[i].match(
			/export\s+(?:const|let)\s+([A-Z][A-Za-z0-9]*)\s*=\s*(?:\([^)]*\)\s*(?:=>|:)|(?:\w+)\s*=>)/,
		);
		const componentName = functionMatch?.[1] ?? constantMatch?.[1] ?? null;
		if (!componentName) continue;

		let braceDepth = 0;
		for (const character of lines[i]) {
			if (character === "{") braceDepth++;
			if (character === "}") braceDepth--;
		}
		const functionDepth = braceDepth;

		for (let j = i + 1; j < lines.length; j++) {
			for (const character of lines[j]) {
				if (character === "{") braceDepth++;
				if (character === "}") braceDepth--;
			}
			if (braceDepth <= functionDepth - 1) break;
			if (!lines[j].trim().startsWith("return")) continue;

			let lineDepth = 0;
			for (const character of lines[j]) {
				if (character === "{") lineDepth++;
				if (character === "}") lineDepth--;
			}
			if (braceDepth - lineDepth !== functionDepth) continue;

			for (let k = j; k < lines.length; k++) {
				const tagPattern = /(<[A-Za-z][A-Za-z0-9.-]*)([\s>\/])/g;
				let tagMatch: RegExpExecArray | null;

				while ((tagMatch = tagPattern.exec(lines[k])) !== null) {
					const matchIndex = tagMatch.index;
					const tag = tagMatch[1];
					const precedingCharacter =
						matchIndex > 0 ? lines[k][matchIndex - 1] : " ";
					if (/[A-Za-z0-9_)>]/.test(precedingCharacter)) continue;

					const insertPosition = matchIndex + tag.length;
					if (
						lines[k]
							.substring(insertPosition, insertPosition + 20)
							.includes("data-component")
					) {
						break;
					}

					lines[k] = `${lines[k].substring(0, insertPosition)} data-component="${componentName}"${lines[k].substring(insertPosition)}`;
					modified = true;
					break;
				}

				if (modified) break;
			}

			break;
		}

		if (modified) break;
	}

	return modified ? lines.join("\n") : null;
}
