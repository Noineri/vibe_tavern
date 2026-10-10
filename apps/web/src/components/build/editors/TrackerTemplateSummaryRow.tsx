import { useState } from "react";
import type { TrackerTemplate } from "@vibe-tavern/domain";
import { describeTrackerTemplate } from "../../../hooks/describe-tracker-template.js";
import { useT } from "../../../i18n/context.js";
import { lblCls } from "../../../lib/field-tokens.js";
import { DestructiveConfirmModal } from "../../shared/destructive-confirm-modal.js";

interface TrackerTemplateSummaryRowProps {
  template: TrackerTemplate;
  onClear: () => Promise<void>;
}

/** Read-only active-version tracker-template summary with its removal confirm. */
export function TrackerTemplateSummaryRow({ template, onClear }: TrackerTemplateSummaryRowProps) {
  const { t } = useT();
  const [removeOpen, setRemoveOpen] = useState(false);

  return (
    <div className="mb-5">
      <label className={lblCls}>{t("character_tracker_template_label")}</label>
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-ui text-[calc(var(--ui-fs)-1px)] leading-[1.5] text-t2">
          {describeTrackerTemplate(template, t)}
        </span>
        <button
          type="button"
          className="cursor-pointer border-0 bg-transparent p-0 font-ui text-[12.5px] text-danger transition-colors hover:underline"
          onClick={() => setRemoveOpen(true)}
        >
          {t("character_tracker_template_remove")}
        </button>
      </div>
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
