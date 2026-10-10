import { useWatch, type UseFormReturn } from "react-hook-form";
import type { BuildCharacterDraft } from "@vibe-tavern/api-contracts";
import { useT } from "../../../i18n/context.js";
import { AutoTextarea } from "../../shared/auto-textarea.js";
import { MobileExpandTextarea } from "../../shared/MobileExpandTextarea.js";
import { lblCls } from "../../../lib/field-tokens.js";
import { TokenCounter } from "../../shared/TokenCounter.js";

interface CharacterCoreTextFieldsProps {
  form: UseFormReturn<BuildCharacterDraft>;
  isSaving: boolean;
}

/** Description and first-message fields, isolated from the classic editor's other watches. */
export function CharacterCoreTextFields({ form, isSaving }: CharacterCoreTextFieldsProps) {
  const { t } = useT();
  const { register, setValue } = form;
  const [description, firstMessage] = useWatch({
    control: form.control,
    name: ["description", "firstMessage"],
  });

  return (
    <>
      {/* Description */}
      <div className="mb-5">
        <label className={lblCls}>{t("char_desc_label")}</label>
        <MobileExpandTextarea value={description || ""} onChange={(value) => setValue("description", value)} label={t("char_desc_label")}>
          <AutoTextarea disabled={isSaving} register={register("description")} minRows={5} />
        </MobileExpandTextarea>
        <TokenCounter text={description || ""} />
      </div>

      {/* First Message */}
      <div className="mb-5">
        <label className={lblCls}>{t("first_message_greeting")}</label>
        <MobileExpandTextarea value={firstMessage || ""} onChange={(value) => setValue("firstMessage", value)} label={t("first_message_label")}>
          <AutoTextarea disabled={isSaving} placeholder={t("first_message_placeholder")} register={register("firstMessage")} minRows={6} />
        </MobileExpandTextarea>
        <TokenCounter text={firstMessage || ""} />
      </div>
    </>
  );
}
