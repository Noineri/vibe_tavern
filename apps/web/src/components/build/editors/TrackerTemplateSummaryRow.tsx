import { useState } from "react";
import type { TrackerTemplate } from "@vibe-tavern/domain";
import { describeTrackerTemplate } from "../../../hooks/describe-tracker-template.js";
import { useT } from "../../../i18n/context.js";
import { lblCls } from "../../../lib/field-tokens.js";
import { AnimatedDisclosure } from "../../shared/AnimatedDisclosure.js";
import { DestructiveConfirmModal } from "../../shared/destructive-confirm-modal.js";
import { Ic } from "../../shared/icons.js";
import { TrackerTemplateSchemaPreview } from "../../shared/tracker-template-schema-preview.js";

interface TrackerTemplateSummaryRowProps {
  template: TrackerTemplate;
  onClear: () => Promise<void>;
}

/** Read-only active-version tracker-template summary with its removal confirm. */
export function TrackerTemplateSummaryRow({ template, onClear }: TrackerTemplateSummaryRowProps) {
  const { t } = useT();
  const [removeOpen, setRemoveOpen] = useState(false);
  const [schemaOpen, setSchemaOpen] = useState(false);

  return (
    <div className="mb-5">
      <label className={lblCls}>{t("character_tracker_template_label")}</label>
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-ui text-[calc(var(--ui-fs)-1px)] leading-[1.5] text-t2">
          {describeTrackerTemplate(template, t)}
        </span>
        <button
          type="button"
          aria-label={t("character_tracker_template_remove_aria")}
          title={t("character_tracker_template_remove_aria")}
          onClick={() => setRemoveOpen(true)}
          className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-danger transition-colors hover:bg-danger/10"
        >
          <Ic.del />
        </button>
      </div>
      <button
        type="button"
        onClick={() => setSchemaOpen((v) => !v)}
        className="flex w-full cursor-pointer select-none items-center gap-1.5 border-0 bg-transparent px-0 py-1 text-left font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-colors hover:text-t2"
      >
        <span>{t("character_tracker_template_schema")}</span>
        <span className="ml-auto">{Ic.caret(schemaOpen ? "u" : "d")}</span>
      </button>
      <AnimatedDisclosure open={schemaOpen}>
        <TrackerTemplateSchemaPreview template={template} />
      </AnimatedDisclosure>
      {removeOpen && (
        <DestructiveConfirmModal
          title={t("character_tracker_template_remove_title")}
          body={t("character_tracker_template_remove_body")}
          confirmLabel={t("character_tracker_template_remove")}
          onConfirm={async () => {
            await onClear();
            setRemoveOpen(false);
          }}
          onCancel={() => setRemoveOpen(false)}
        />
      )}
    </div>
  );
}
