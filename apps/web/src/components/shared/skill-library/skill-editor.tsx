import { useState } from "react";
import { AiAssistantModal } from "../AiAssistantModal.js";
import { AutoTextarea } from "../auto-textarea.js";
import { TextInput } from "../text-input.js";
import { Ic } from "../icons.js";
import { useT } from "../../../i18n/context.js";
import type { TDynamic } from "../../../i18n/locale-helpers.js";
import { lblCls } from "../../../lib/field-tokens.js";
import { cn } from "../../../lib/cn.js";
import type { SkillLibraryLabels, SkillLibraryTestids } from "./skill-library-adapter.js";

/** The editor draft (AP-23d): the three saved fields — `name` + `description`
 *  become the manifest frontmatter, `body` the skill text below the fence. */
export interface SkillDraft {
	name: string;
	description: string;
	body: string;
}

export const BLANK_SKILL_DRAFT: SkillDraft = { name: "", description: "", body: "" };

/**
 * The skill editor (AP-23d, AGENT_SHELL_POLISH Wave 5 — mockup §8). A sibling
 * of the merged modal per the plan: the modal owns the session (which skill,
 * view vs edit, save, the dirty guard) and this file owns ONLY the editor
 * fields. Controlled — every keystroke reports up through `onChange`, so the
 * modal can pin `dirty`, guard the close, and build the save payload.
 *
 * Fields (mockup §8): the name field (`TextInput`), the when-to-use field
 * (`AutoTextarea` + the verbatim hint — the assistant reads this description
 * to decide when to open the skill), the skill-text field (`AutoTextarea mono`,
 * tall) with the canonical compact AI-assistant button (`Ic.brain`,
 * `apiMode="skill"`) opening the shared AI modal. Replace/insert semantics
 * mirror `LoreEntryEditor`'s AI integration (replace swaps the body, insert
 * appends after a blank line).
 */
export function SkillEditor({ draft, onChange, labels, testids, t }: {
	draft: SkillDraft;
	onChange: (next: SkillDraft) => void;
	labels: SkillLibraryLabels;
	testids: SkillLibraryTestids;
	t: TDynamic;
}) {
	const { t: tStrict } = useT();
	const [isAiOpen, setIsAiOpen] = useState(false);

	return (
		<div className="flex flex-col gap-5">
			<div>
				<div className={lblCls}>{t(labels.nameLabel)}</div>
				<TextInput
					data-testid={testids.editorName}
					aria-label={t(labels.nameLabel)}
					value={draft.name}
					onChange={(e) => onChange({ ...draft, name: e.target.value })}
				/>
			</div>
			<div>
				<div className={lblCls}>{t(labels.whenLabel)}</div>
				<AutoTextarea
					data-testid={testids.editorWhen}
					aria-label={t(labels.whenLabel)}
					value={draft.description}
					onChange={(e) => onChange({ ...draft, description: e.target.value })}
				/>
				<p className="mt-1 font-ui text-[calc(var(--ui-fs)-2px)] leading-relaxed text-t3">
					{t(labels.whenHint)}
				</p>
			</div>
			<div>
				<div className="mb-1.5 flex items-center justify-between">
					<span className={cn(lblCls, "!mb-0")}>
						{t(labels.bodyLabel)}
					</span>
					<button
						type="button"
						data-testid={testids.aiAssistBtn}
						className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-s3 px-2.5 font-ui text-[11px] text-t2 transition-all hover:bg-s2 hover:text-t1"
						onClick={() => setIsAiOpen(true)}
					>
						<Ic.brain /> {tStrict("script_ai_helper")}
					</button>
				</div>
				<AutoTextarea
					mono
					data-testid={testids.editorBody}
					aria-label={t(labels.bodyLabel)}
					value={draft.body}
					onChange={(e) => onChange({ ...draft, body: e.target.value })}
					minRows={8}
					macroAutocomplete={false}
				/>
			</div>
			<AiAssistantModal
				isOpen={isAiOpen}
				onClose={() => setIsAiOpen(false)}
				apiMode="skill"
				existingContent={draft.body}
				onReplace={(text) => onChange({ ...draft, body: text })}
				onInsert={(text) =>
					onChange({ ...draft, body: draft.body ? `${draft.body.trimEnd()}\n\n${text}` : text })
				}
				mode="full"
			/>
		</div>
	);
}
