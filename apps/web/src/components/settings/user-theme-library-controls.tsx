import { useRef, useState } from "react";
import { MAX_USER_THEME_BYTES, type UserThemeSummary } from "@vibe-tavern/api-contracts";
import { useT } from "../../i18n/context.js";
import { UserThemeUploadError } from "../../api/user-theme-api.js";
import { useInterfaceSettingsStore } from "../../stores/interface-settings-store.js";
import { useUserThemesStore } from "../../stores/user-themes-store.js";
import { Icons } from "../shared/icons.js";
import { DestructiveConfirmModal } from "../shared/destructive-confirm-modal.js";
import { CustomTooltip } from "../shared/Tooltip.js";

const compactButton = "flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-s3 px-2.5 font-ui text-[calc(var(--ui-fs)-3px)] text-t2 transition-all hover:bg-s2 hover:text-t1 disabled:opacity-50";

/** Section-only management; the shared body owns selection on every surface. */
export function UserThemeLibraryControls() {
  const { t } = useT();
  const themes = useUserThemesStore((state) => state.themes);
  const catalogError = useUserThemesStore((state) => state.error);
  const loading = useUserThemesStore((state) => state.loading);
  const [pendingDelete, setPendingDelete] = useState<UserThemeSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    const previousTheme = useInterfaceSettingsStore.getState().settings.theme;
    setBusy(true); setError(null);
    try {
      if (file.size > MAX_USER_THEME_BYTES) throw new UserThemeUploadError(413);
      const theme = await useUserThemesStore.getState().upload({ name: file.name, css: await file.text() });
      if (useInterfaceSettingsStore.getState().settings.theme === previousTheme) useInterfaceSettingsStore.getState().setSetting("theme", `user:${theme.id}`);
    } catch (cause) {
      setError(cause instanceof UserThemeUploadError && (cause.status === 400 || cause.status === 413)
        ? t("user_theme_upload_invalid") : t("user_theme_upload_failed"));
    } finally { setBusy(false); }
  }
  async function remove(theme: UserThemeSummary) {
    setPendingDelete(null); setBusy(true); setError(null);
    try { await useUserThemesStore.getState().remove(theme.id); }
    catch { setError(t("user_theme_remove_failed")); }
    finally { setBusy(false); }
  }

  return (
    <div className="mt-5 border-t border-border2 pt-4">
      <div className="mb-3 font-ui text-[calc(var(--ui-fs)-3px)] font-semibold uppercase tracking-[0.05em] text-t1">{t("user_theme_library")}</div>
      {themes.map((theme) => (
        <div key={theme.id} className="flex items-center justify-between gap-3 py-2">
          <span className="min-w-0 break-words text-[calc(var(--ui-fs)-2px)] text-t2">{theme.name}</span>
          <CustomTooltip content={t("user_theme_remove", { name: theme.name })}>
            <button type="button" className={`${compactButton} shrink-0 hover:text-danger`} disabled={busy} aria-label={t("user_theme_remove", { name: theme.name })} onClick={() => setPendingDelete(theme)}><Icons.Trash /></button>
          </CustomTooltip>
        </div>
      ))}
      <button type="button" className={`${compactButton} mt-2`} disabled={busy} onClick={() => input.current?.click()}><Icons.Import />{t("user_theme_upload")}</button>
      <input ref={input} type="file" accept=".css,text/css" className="hidden" aria-label={t("user_theme_upload")} disabled={busy} onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (file) void upload(file);
      }} />
      <p className="mt-2 text-[calc(var(--ui-fs)-3px)] text-t3">{t("user_theme_upload_hint")}</p>
      {error && <p role="alert" className="mt-2 text-[calc(var(--ui-fs)-2px)] text-danger">{error}</p>}
      {catalogError && <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-[calc(var(--ui-fs)-3px)] text-t3">{t("user_theme_catalog_failed")}</span>
        <button type="button" className={compactButton} disabled={loading} onClick={() => { void useUserThemesStore.getState().load().catch(() => undefined); }}>{t("retry")}</button>
      </div>}
      {pendingDelete && <DestructiveConfirmModal
        title={t("user_theme_remove_title")}
        body={t("user_theme_remove_body", { name: pendingDelete.name })}
        confirmLabel={t("delete")}
        onConfirm={() => { void remove(pendingDelete); }}
        onCancel={() => setPendingDelete(null)}
      />}
    </div>
  );
}
