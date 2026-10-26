import { Icons } from "../../shared/icons.js";
import { useT } from "../../../i18n/context.js";
import {
  usePendingVariantAttachments,
  useSidechatVariantAttachmentsStore,
} from "../../../stores/sidechat-variant-attachments-store.js";

/**
 * The sidechat composer's attached-variant chips (SIDECHAT_PLAN, Wave 5 /
 * SC-18) — the pending list the «Discuss in the sidechat» RP-message entry
 * parked, rendered as removable chips above the textarea.
 *
 * Chrome mirrors `AgentContextPills` (the pinned-context pills sharing this
 * card): the same row, the same chip shape, an × per chip. Copy is
 * `#N · selected-variant-text` / `#N · alternative-text` (`N` = the variant
 * number the RP shows, `variantIndex + 1`) through the `sidechat_chip_*`
 * keys. Renders nothing when empty.
 */
export function SidechatVariantChips({ chatId, branchId }: {
  chatId: string;
  branchId: string;
}) {
  const { t } = useT();
  const chips = usePendingVariantAttachments(chatId, branchId);
  if (chips.length === 0) return null;
  return (
    <div
      role="list"
      aria-label={t("sidechat_chips_label")}
      className="flex flex-wrap items-center gap-1.5 px-4 pt-2.5"
    >
      {chips.map((chip) => {
        const label = chip.selected
          ? t("sidechat_chip_selected", { n: chip.variantNumber })
          : t("sidechat_chip_alternative", { n: chip.variantNumber });
        return (
          <div
            key={`${chip.messageId}:${chip.variantId}`}
            role="listitem"
            data-testid={`sidechat-variant-chip-${chip.messageId}-${chip.variantId}`}
            className="flex items-center gap-1 rounded-[5px] bg-s2 px-2 py-0.5 font-ui text-[calc(var(--ui-fs)-3px)] text-t2"
          >
            <span className="max-w-[160px] truncate">{label}</span>
            <button
              type="button"
              data-testid={`sidechat-variant-chip-remove-${chip.messageId}-${chip.variantId}`}
              aria-label={t("sidechat_chip_remove", { label })}
              className="flex h-4 w-4 items-center justify-center rounded text-t4 transition-colors hover:text-danger-text"
              onClick={() =>
                useSidechatVariantAttachmentsStore
                  .getState()
                  .removeVariantAttachment(chatId, branchId, chip.messageId, chip.variantId)
              }
            >
              <Icons.close className="h-3 w-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
