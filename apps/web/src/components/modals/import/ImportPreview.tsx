/**
 * Presentational preview components for the character + chat import flows.
 *
 * Extracted from `ImportModals.tsx` (plan unit IF-2) so the desktop modal flow
 * and the future mobile picker flow (IF-5) share one render path. Pure JSX over
 * the `CharacterPreview` / `ChatPreview` shapes from `parse-import-file.ts` —
 * no parsing, no local state, no modal/chrome ownership. The caller owns avatar
 * URL revocation and the surrounding modal frame.
 */
import { cn } from "../../../lib/cn.js";
import { useT } from "../../../i18n/context.js";
import {
  initial,
  truncate,
  type CharacterPreview,
  type ChatPreview,
} from "./parse-import-file.js";

export function CharacterImportPreview({ preview }: { preview: CharacterPreview }) {
  const { t } = useT();
  return (
    <div>
      <div className="flex gap-4 rounded-lg border border-border bg-s2 p-4">
        {preview.avatarUrl ? (
          <img src={preview.avatarUrl} className="h-16 w-16 shrink-0 rounded-lg bg-s3 object-cover object-top" alt="" />
        ) : (
          <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg bg-s3 font-body text-2xl italic text-t3">{initial(preview.name)}</div>
        )}
        <div className="min-w-0 flex-1 font-ui">
          <div className="mb-1 text-base font-medium text-t1">{preview.name}</div>
          <div className="line-clamp-3 mb-2.5 text-xs leading-relaxed text-t3">{preview.description || t("no_description")}</div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {preview.tags.slice(0, 6).map((tag) => <span key={tag} className="rounded bg-s3 px-2.5 py-1 font-ui text-[calc(var(--ui-fs)-3px)] text-t2">{tag}</span>)}
          </div>
        </div>
      </div>
      <div className="mt-3 font-ui text-xs text-t3">{t("ready_to_import", { name: preview.file.name })}</div>
    </div>
  );
}

export function ChatImportPreview({ preview }: { preview: ChatPreview }) {
  const { t } = useT();
  return (
    <div>
      <div className="mb-3 flex items-center justify-between rounded-lg border border-border bg-s2 px-4 py-3">
        <div>
          <div className="font-ui text-sm font-medium text-t1">{t("parsed_preview")}</div>
          <div className="font-ui text-xs text-t3">{preview.fileName} · {preview.messageCount} {t("import_messages_label")} · {t("import_character_label")} {preview.characterName}</div>
        </div>
        <div className="rounded-full bg-success-dim px-2.5 py-0.5 font-ui text-xs font-medium text-success-text">{t("ready")}</div>
      </div>
      <div className="max-h-[250px] overflow-y-auto">
        {preview.messages.map((message, index) => (
          <div key={index} className={cn("flex items-start gap-2 rounded-md px-2 py-1.5", message.role === "user" && "bg-s2")}>
            <div className={cn("min-w-[44px] shrink-0 pt-0.5 font-ui text-[calc(var(--ui-fs)-3px)] font-semibold", message.role === "user" ? "text-info" : "text-accent-t")}>{message.name}</div>
            <div className="font-ui text-[calc(var(--ui-fs)-2px)] text-t2">{truncate(message.text, 140)}</div>
          </div>
        ))}
      </div>
      <div className="mt-2 font-ui text-xs text-t3">{t("showing_parsed_messages", { n: preview.messages.length })}</div>
    </div>
  );
}
