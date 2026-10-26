/**
 * The ONE shared `lib/markdown.js` seam for the agent-shell message suites
 * (AgentMessageBlock.test.tsx + AgentMessageList.test.tsx).
 *
 * CO-LOAD CONTRACT (same discipline as test/react-markdown-seam.ts): `mock.module`
 * is process-global and last-write-wins, and a hand-bundled pair run shares the
 * module registry — so when only the block suite mocked markdown.js, its stub
 * factory replaced the real renderer for the LIST suite's renders in the same
 * process (the pair failed 2 AP-2 variant tests while each file was green
 * alone; the list suite pinned the REAL variant classes `.md-agent-plain` /
 * `.md-agent`, which the stub never rendered). The fix is the react-markdown
 * seam rule: every file in the set registers the SAME factory, so whichever
 * registration is live — in any discovery order — the behavior is identical.
 *
 * The factory is the superset both suites need, in the mandatory R4 shape
 * (spread the real namespace, override exactly one export):
 *  - the deterministic stub DOM the block suite pins: ONE element with the raw
 *    text as its direct child (so `getByText("…`score`…")` matches despite the
 *    backticks, and the text's parent is the block's `translate="yes"` body)
 *    plus the variant surfaced as `data-variant` (the AP-2/AP-4 markup pins);
 *  - the REAL variant class on the same element, derived from markdown.tsx's
 *    exported VARIANT_DEFAULT_CLASS (the one derivation — no hand-copied map),
 *    so the list suite's AP-2 pair keeps pinning the whole chain
 *    (descriptor → list → block → variant class) with its assertions untouched.
 *
 * Why NOT delegate to the real renderer (unlike the react-markdown seam, which
 * records and delegates): the block suite pins the stub SHAPE. Delegation would
 * insert the real `div.md-content` + `<p>` between the text and the block's
 * `translate="yes"` body and split inline code out of the text node — the
 * page-translation and raw-text assertions would break. The superset here is
 * stub-with-the-real-class, not delegate.
 *
 * The DELEGATION CAPTURE RULE does not bite: the factory never calls through
 * the captured namespace (no re-entry path), and the class map is a shallow
 * copy taken at load — plain string data that in-place slot replacement cannot
 * alias. Call `installAgentMessageMarkdownSeam()` in the test-file body BEFORE
 * importing the component under test: `mock.module` only affects modules
 * imported after the registration.
 */
import { mock } from "bun:test";
import type { ComponentProps } from "react";

const realMarkdown = await import("../src/lib/markdown.js");
type RealMarkdownProps = ComponentProps<typeof realMarkdown.Markdown>;
/** The real variant→class map, copied at load — one source: markdown.tsx. */
const variantClasses: Record<NonNullable<RealMarkdownProps["variant"]>, string> = {
	...realMarkdown.VARIANT_DEFAULT_CLASS,
};

/** Register the shared agent-message markdown seam (idempotent: same shape on re-registration). */
export function installAgentMessageMarkdownSeam(): void {
	mock.module("../src/lib/markdown.js", () => ({
		...realMarkdown,
		Markdown: function AgentMessageMarkdownSeam({ text, className, variant = "chat" }: RealMarkdownProps) {
			if (!text) return null;
			return (
				<div data-variant={variant} className={className || variantClasses[variant]}>
					{text}
				</div>
			);
		},
	}));
}
