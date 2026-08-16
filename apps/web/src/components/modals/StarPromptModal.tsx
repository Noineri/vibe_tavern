import { Modal } from "../shared/Modal.js";
import { Logo } from "../shared/Logo.js";
import { Icons } from "../shared/icons.js";
import { useT } from "../../i18n/context.js";
import { useModalStore } from "../../stores/modal-store.js";
import { useBootstrapStore, patchUiSettingsAction } from "../../stores/api-actions/bootstrap-actions.js";
import { nextStarPromptAt, repoWebUrl } from "../../lib/star-prompt.js";

/**
 * Periodic "please star the repo" ask. Opened by the due check in
 * star-prompt-trigger once a reply has finished streaming; the schedule itself
 * lives in lib/star-prompt.ts.
 *
 * The opt-out is a link below the button row rather than a third button: three
 * equal buttons force a choice between three equal-looking options, and "Later"
 * should read as the cheap default. Escape and overlay dismiss both route to
 * "Later" — dismissing is a deferral, not consent to be asked again on the very
 * next reply.
 */
export function StarPromptModal() {
  const { t } = useT();
  const open = useModalStore((s) => s.isStarPromptOpen);
  const setOpen = useModalStore((s) => s.setStarPromptOpen);
  const settings = useBootstrapStore((s) => s.data?.uiSettings ?? null);

  if (!open) return null;

  // Fire-and-forget: the decision is already reflected in the UI, and a failed
  // write only means the user gets asked again later.
  const persist = (patch: Parameters<typeof patchUiSettingsAction>[0]) => {
    setOpen(false);
    void patchUiSettingsAction(patch).catch((error: unknown) => {
      console.error("Failed to persist the star prompt decision", error);
    });
  };

  const onStar = () => {
    window.open(repoWebUrl(), "_blank", "noopener,noreferrer");
    persist({ githubStarred: true });
  };

  const onLater = () => {
    const deferrals = (settings?.starPromptDeferrals ?? 0) + 1;
    const count = settings?.userMessageCount ?? 0;
    persist({ starPromptDeferrals: deferrals, nextStarPromptAt: nextStarPromptAt(count, deferrals) });
  };

  const onNever = () => persist({ githubStarred: true });

  return (
    <Modal open={open} onClose={onLater} compact title={t("star_prompt_title")} description={t("star_prompt_body")}>
      <div className="w-[380px] rounded-lg border border-border bg-surface p-7 text-center shadow-xl">
        <Logo className="mx-auto mb-3.5 h-[38px] w-[62px]" />
        <div className="mb-[7px] text-base font-medium text-t1">{t("star_prompt_title")}</div>
        <div className="mb-5 text-[13px] leading-[1.55] text-t3">{t("star_prompt_body")}</div>
        {/* flex-wrap, not a fixed width: Russian runs 20-30% longer and must be
            allowed to break to a second row instead of overflowing. */}
        <div className="flex flex-wrap justify-center gap-2.5">
          <button
            type="button"
            className="h-8 cursor-pointer rounded-md border border-border bg-transparent px-3.5 font-ui text-[12.5px] text-t3 transition-colors duration-150 hover:text-t1"
            onClick={onLater}
          >
            {t("star_prompt_later")}
          </button>
          <button
            type="button"
            className="flex h-8 cursor-pointer items-center gap-1.5 rounded-md border-0 bg-accent px-[18px] font-ui text-[12.5px] font-medium text-on-accent transition-[filter] duration-100 hover:brightness-110"
            onClick={onStar}
          >
            <Icons.star />
            {t("star_prompt_cta")}
          </button>
        </div>
        <button
          type="button"
          className="mt-4 cursor-pointer border-0 bg-transparent font-ui text-[12px] text-t3 underline underline-offset-[3px] transition-colors hover:text-t2"
          onClick={onNever}
        >
          {t("star_prompt_never")}
        </button>
      </div>
    </Modal>
  );
}
