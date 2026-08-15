import { type Extension } from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	EditorView,
	ViewPlugin,
	type ViewUpdate,
	WidgetType,
} from "@codemirror/view";
import type { TextDiffSummary } from "../../../shared/TextDiffPreview.js";
import type { DiffHunk } from "../../../../lib/coauthor-hunk-merge.js";
import { groupHunks } from "../../../../lib/coauthor-hunk-merge.js";

/**
 * CD-5: inline diff decorations for the copilot editor's review mode.
 *
 * RENDER MODEL (see COPILOT_EDITOR_DIFF_PLAN, Wave 3): while a proposal is
 * pending, the CodeEditor's DOCUMENT is the full proposed buffer text. Every
 * UNACCEPTED hunk renders in place — its added lines get the green diff
 * highlight (`--success-dim`, the same token the chat diff preview uses), and
 * a block widget above the hunk carries the struck-through ghost of the lines
 * it would remove plus the hunk's «принять» button. Accepted hunks render as
 * plain text (their lines are already part of the buffer via
 * `mergeSelectedHunks`). This is a review surface, not a merge editor: the
 * ghost lines are read-only context, never editable text.
 *
 * Two layers, deliberately split:
 *  1. `computeDiffDecorationSpecs` — PURE: diff + hunks + accepted-set → a
 *     positional spec list (0-based document line numbers). Unit-tested
 *     without mounting CodeMirror.
 *  2. `copilotDiffExtensions` — the thin CM6 layer (line decorations + block
 *     widgets) that maps the specs onto the live document.
 */

/** A pure, DOM-free description of one decoration. `line` is 0-based in the
 *  document (= proposed text); a `hunk-header` anchored at `line === docLines`
 *  (past EOF) belongs to a hunk whose changes sit at the document tail. */
export type CopilotDiffSpec =
	| { type: "add-line"; line: number }
	| { type: "hunk-header"; line: number; hunkId: number; removedTexts: string[] };

/**
 * Compute the decoration specs for the unaccepted hunks of a line diff.
 * `hunks` may be omitted (computed via `groupHunks` then) so callers that only
 * hold the diff work; accepted hunks produce NOTHING (their lines are already
 * ordinary buffer text). A `tooLarge` diff has no lines to map — no specs.
 */
export function computeDiffDecorationSpecs(
	diff: TextDiffSummary,
	hunks: readonly DiffHunk[] = groupHunks(diff),
	acceptedHunkIds: ReadonlySet<number> = new Set(),
): CopilotDiffSpec[] {
	if (diff.tooLarge) return [];
	// Map each diff line index → its hunk id (null = context), same as
	// mergeSelectedHunks so specs and merges always agree on hunk membership.
	const lineHunk: (number | null)[] = diff.lines.map(() => null);
	for (const hunk of hunks) {
		for (let k = hunk.start; k < hunk.end; k++) lineHunk[k] = hunk.id;
	}

	const specs: CopilotDiffSpec[] = [];
	let docLine = 0; // 0-based line number of the NEXT document (proposed) line
	let header: { line: number; hunkId: number; removedTexts: string[] } | null = null;

	/** Open the hunk's header spec (once) at the given anchor line. The spec's
	 *  `removedTexts` array is shared by reference, so later remove lines of
	 *  the same hunk still accumulate into the already-emitted spec. */
	const openHeader = (line: number, hunkId: number) => {
		if (header) return;
		header = { line, hunkId, removedTexts: [] };
		specs.push({ type: "hunk-header", ...header });
	};

	for (let k = 0; k < diff.lines.length; k++) {
		const line = diff.lines[k]!;
		const hunkId = lineHunk[k];
		const unaccepted = hunkId !== null && !acceptedHunkIds.has(hunkId);
		if (line.kind === "same") {
			header = null;
			docLine++;
		} else if (line.kind === "add") {
			if (unaccepted) {
				// First document line of the hunk: the header (ghost + button)
				// anchors above it, BEFORE its highlighted lines.
				openHeader(docLine, hunkId!);
				specs.push({ type: "add-line", line: docLine });
			} else {
				header = null;
			}
			docLine++;
		} else {
			// remove: the line exists only in the BASE buffer. For an unaccepted
			// hunk it becomes a struck ghost line in the pending header; for an
			// accepted hunk the removal is taken (no ghost).
			if (unaccepted) {
				// A pure-deletion hunk (removals with no preceding add line): the
				// header anchors above the NEXT document line.
				openHeader(docLine, hunkId!);
				header!.removedTexts.push(line.text);
			}
		}
	}
	// A hunk at the document tail keeps its already-emitted header.
	return specs;
}

// ─── CM6 layer ──────────────────────────────────────────────────────────────

const ADD_LINE_CLASS = "cm-copilotDiffAdd";

/** Block widget above an unaccepted hunk: struck-through ghost of the removed
 *  lines (when any) + the hunk's accept button. */
class HunkHeaderWidget extends WidgetType {
	constructor(
		readonly hunkId: number,
		readonly removedTexts: string[],
		readonly buttonLabel: string,
		readonly buttonTestLabel: string,
		readonly onAccept: (hunkId: number) => void,
	) {
		super();
	}

	override eq(other: HunkHeaderWidget): boolean {
		return (
			this.hunkId === other.hunkId &&
			this.buttonLabel === other.buttonLabel &&
			this.removedTexts.join("\u0000") === other.removedTexts.join("\u0000")
		);
	}

	toDOM(): HTMLElement {
		const wrap = document.createElement("div");
		wrap.className = "cm-copilotDiffHunk";
		wrap.dataset.hunkId = String(this.hunkId);
		if (this.removedTexts.length > 0) {
			const ghost = document.createElement("div");
			ghost.className = "cm-copilotDiffGhost";
			for (const text of this.removedTexts) {
				const row = document.createElement("div");
				row.textContent = text.length > 0 ? `− ${text}` : "−";
				ghost.appendChild(row);
			}
			wrap.appendChild(ghost);
		}
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "cm-copilotDiffAccept";
		btn.textContent = this.buttonLabel;
		btn.setAttribute("aria-label", this.buttonTestLabel);
		btn.dataset.hunkId = String(this.hunkId);
		btn.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.onAccept(this.hunkId);
		});
		wrap.appendChild(btn);
		return wrap;
	}

	override ignoreEvent(): boolean {
		// Let the button's click reach our listener (CM6 swallows events by default).
		return false;
	}
}

function buildDecorations(
	view: EditorView,
	specs: readonly CopilotDiffSpec[],
	factory: (spec: Extract<CopilotDiffSpec, { type: "hunk-header" }>) => HunkHeaderWidget,
): DecorationSet {
	const decorations: { from: number; to: number; deco: Decoration; order: number }[] = [];
	const doc = view.state.doc;
	for (const spec of specs) {
		if (spec.type === "add-line") {
			const line = doc.line(Math.min(spec.line + 1, doc.lines));
			decorations.push({
				from: line.from,
				to: line.from,
				deco: Decoration.line({ class: ADD_LINE_CLASS }),
				// Line decorations at a position sort before the block widget of
				// the same hunk header — widget first (order −1) so the header
				// renders ABOVE the first highlighted line.
				order: 0,
			});
		} else {
			const atEof = spec.line >= doc.lines;
			const line = atEof ? doc.line(doc.lines) : doc.line(spec.line + 1);
			const pos = atEof ? doc.length : line.from;
			decorations.push({
				from: pos,
				to: pos,
				deco: Decoration.widget({
					widget: factory(spec),
					side: -1,
					block: true,
				}),
				order: -1,
			});
		}
	}
	// Decoration.set(sort=true) relieves us from RangeSetBuilder's strict
	// by-position insertion order (block widgets vs line decorations).
	return Decoration.set(
		decorations
			.sort((a, b) => a.from - b.from || a.order - b.order)
			.map((d) => d.deco.range(d.from, d.to)),
		true,
	);
}

/** Theme tokens for the diff chrome. `--success-dim` / `--success-text` are the
 *  same variables the chat-side `TextDiffPreview` add-lines use, so both diff
 *  surfaces share one green. Touch targets ≥36px per the plan's mobile rule. */
const diffTheme = EditorView.theme({
	[`.${ADD_LINE_CLASS}`]: {
		backgroundColor: "var(--success-dim)",
	},
	".cm-copilotDiffHunk": {
		display: "flex",
		alignItems: "center",
		gap: "6px",
		padding: "1px 6px",
		fontFamily: "var(--font-ui)",
	},
	".cm-copilotDiffGhost": {
		fontFamily: "var(--font-mono)",
		fontSize: "12px",
		color: "var(--t4)",
		textDecoration: "line-through",
		opacity: 0.75,
		whiteSpace: "pre-wrap",
		overflowWrap: "break-word",
	},
	".cm-copilotDiffAccept": {
		flex: "none",
		minHeight: "26px",
		padding: "0 10px",
		marginLeft: "auto",
		border: "none",
		borderRadius: "5px",
		backgroundColor: "var(--accent)",
		color: "var(--on-accent)",
		fontFamily: "var(--font-ui)",
		fontSize: "12px",
		cursor: "pointer",
	},
});

export interface CopilotDiffExtensionsOptions {
	/** Decoration specs (see `computeDiffDecorationSpecs`). */
	specs: readonly CopilotDiffSpec[];
	/** Accept-button label (already i18n-resolved). */
	buttonLabel: string;
	/** Accept-button accessible name (already i18n-resolved). */
	buttonAriaLabel: string;
	/** Invoked when a hunk's accept button is clicked. */
	onAcceptHunk: (hunkId: number) => void;
}

/** The CM6 extension bundle: green add-lines + hunk-header block widgets.
 *  The plugin captures `options` (specs included) at construction; passing a
 *  NEW array identity through this function makes CodeEditor's extensions
 *  compartment RECONFIGURE — the plugin is recreated with the fresh specs, so
 *  an accept (which changes the specs but not the document) is reflected
 *  without any docChanged. Callers therefore rebuild the array on every
 *  selection change, not on a timer. */
export function copilotDiffExtensions(options: CopilotDiffExtensionsOptions): Extension[] {
	const plugin = ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			constructor(view: EditorView) {
				this.decorations = buildDecorations(view, options.specs, (spec) =>
					new HunkHeaderWidget(
						spec.hunkId,
						spec.removedTexts,
						options.buttonLabel,
						options.buttonAriaLabel,
						options.onAcceptHunk,
					),
				);
			}
			update(update: ViewUpdate) {
				if (update.docChanged || update.viewportChanged) {
					this.decorations = buildDecorations(update.view, options.specs, (spec) =>
						new HunkHeaderWidget(
							spec.hunkId,
							spec.removedTexts,
							options.buttonLabel,
							options.buttonAriaLabel,
							options.onAcceptHunk,
						),
					);
				}
			}
		},
		{ decorations: (v) => v.decorations },
	);
	return [diffTheme, plugin];
}
