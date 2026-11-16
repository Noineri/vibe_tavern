import { useT } from "../../i18n/context.js";
import { CustomTooltip } from "../shared/Tooltip.js";

export function ImageGenPromptCapCounter({ length, cap }: { length: number; cap: number }) {
  const { t } = useT();
  return (
    <CustomTooltip content={t("image_gen_prompt_cap_hint")}>
      <div
        data-testid="image-gen-ft-prompt-cap"
        className={`flex justify-end font-ui text-[calc(var(--ui-fs)-3px)] ${
          length > cap ? "text-danger" : "text-t4"
        }`}
      >
        {length} / {cap}
      </div>
    </CustomTooltip>
  );
}
