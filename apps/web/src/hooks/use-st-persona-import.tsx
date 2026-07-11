import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { parseStPersonas, type StPersonaEntry } from "@vibe-tavern/import-export";
import { toast } from "sonner";
import { createPersona, uploadPersonaAvatar } from "../app-client.js";
import { fetchBootstrapAction, fetchPersonasAction } from "../stores/api-actions/bootstrap-actions.js";
import { cn } from "../lib/cn.js";
import { useIsMobile } from "./use-mobile.js";
import { useT } from "../i18n/context.js";
import { Icons } from "../components/shared/icons.js";
import { CustomTooltip } from "../components/shared/Tooltip.js";
import { Checkbox } from "../components/shared/Checkbox.js";

/**
 * useStPersonaImport — the SillyTavern persona import flow, extracted from
 * PersonaModal (PERSONA_MODAL_GOD_OBJECT_AUDIT.md, Finding 1).
 *
 * Self-contained: owns the parse → preview → batch-create state machine and the
 * trigger / preview / hidden-input UI. Returns render nodes the host scatters
 * into the existing layout slots — `triggers` in the footer button row, `preview`
 * + `hiddenInputs` as content siblings after the footer. See the report for why
 * this is a hook and not a single-placement component: the ST UI spans two layout
 * locations, so a component at one spot would force the preview panel into the
 * footer flex row and break layout.
 *
 * Calls createPersona / uploadPersonaAvatar / fetchBootstrapAction /
 * fetchPersonasAction directly; the import refetches the persona list itself, so
 * the host needs no callback wiring — just `{ isOpen }` (to reset the tooltip
 * defer on close, since the host is always-mounted behind a Radix Dialog).
 */
export function useStPersonaImport({ isOpen }: { isOpen: boolean }): {
  triggers: ReactNode;
  preview: ReactNode;
  hiddenInputs: ReactNode;
} {
  const { t } = useT();
  const isMobile = useIsMobile();

  const [stImportPreview, setStImportPreview] = useState<StPersonaEntry[] | null>(null);
  // PR-9: defer enabling the import tooltip until after the modal opening
  // animation/settling. Radix Dialog.Content auto-focuses on open, and the
  // global TooltipProvider has a short delayDuration — together they caused
  // the tooltip to flash on modal mount. We enable the tooltip only after a
  // short delay, so it opens on genuine hover/focus but never on mount.
  const [importTooltipReady, setImportTooltipReady] = useState(false);
  const [stImportSelected, setStImportSelected] = useState<Set<string>>(new Set());
  const [stImporting, setStImporting] = useState(false);
  const [stImportProgress, setStImportProgress] = useState<{ current: number; total: number } | null>(null);
  const stFolderRef = useRef<HTMLInputElement>(null);
  const stFileRef = useRef<HTMLInputElement>(null);
  const stAvatarFiles = useRef<Map<string, File>>(new Map());

  useEffect(() => {
    if (!isOpen) { setImportTooltipReady(false); return; }
    const timer = setTimeout(() => setImportTooltipReady(true), 400);
    return () => clearTimeout(timer);
  }, [isOpen]);

  async function handleStFolderPick(files?: FileList | null): Promise<void> {
    if (!files || files.length === 0) return;

    // Find settings.json and avatar PNGs in the picked folder
    let settingsFile: File | null = null;
    const avatarMap = new Map<string, File>();

    for (const file of Array.from(files)) {
      const rp = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
      if (!rp) continue;

      if (rp.endsWith("/settings.json")) {
        settingsFile = file;
      }
      // Match .../User Avatars/<key>.png
      const parts = rp.split("/");
      const avIdx = parts.lastIndexOf("User Avatars");
      if (avIdx >= 0 && file.name.toLowerCase().endsWith(".png")) {
        avatarMap.set(file.name, file);
      }
    }

    if (!settingsFile) {
      toast.error(t("st_no_settings_json"));
      return;
    }

    try {
      const text = await settingsFile.text();
      const parsed = JSON.parse(text);
      const entries = parseStPersonas(parsed);
      if (entries.length === 0) {
        toast.error(t("st_no_personas_found"));
        return;
      }
      stAvatarFiles.current = avatarMap;
      setStImportPreview(entries);
      setStImportSelected(new Set(entries.map(e => e.key)));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("st_parse_failed"));
    }
  }

  // Single .json file import — accepts either ST backup/export shape
  // (top-level personas, what exportPersona('st') emits) or a raw ST
  // settings.json (power_user.*). No avatars (they live as separate PNGs in
  // ST's folder layout, not embedded in the JSON) — personas import bare.
  async function handleStFilePick(files?: FileList | null): Promise<void> {
    if (!files || files.length === 0) return;
    const file = files[0];
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const entries = parseStPersonas(parsed);
      if (entries.length === 0) {
        toast.error(t("st_no_personas_found"));
        return;
      }
      stAvatarFiles.current = new Map();
      setStImportPreview(entries);
      setStImportSelected(new Set(entries.map(e => e.key)));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("st_parse_failed"));
    }
  }

  async function handleStImport(): Promise<void> {
    if (!stImportPreview || stImportPreview.length === 0) return;
    const toImport = stImportPreview.filter(e => stImportSelected.has(e.key));
    if (toImport.length === 0) return;
    setStImporting(true);
    setStImportProgress({ current: 0, total: toImport.length });

    let imported = 0;
    let didSetDefault = false;
    const errors: string[] = [];
    for (let i = 0; i < toImport.length; i++) {
      const entry = toImport[i];
      setStImportProgress({ current: i + 1, total: toImport.length });
      try {
        const shouldSetDefault = entry.isDefault && !didSetDefault;
        const persona = await createPersona({
          name: entry.name,
          description: entry.description,
          defaultForNewChats: shouldSetDefault ? true : undefined,
        });
        if (shouldSetDefault) didSetDefault = true;

        // Upload avatar to the persona's entity folder (sets avatarExt).
        const avatarFile = stAvatarFiles.current.get(entry.key);
        if (avatarFile) {
          try {
            await uploadPersonaAvatar(persona.id, avatarFile);
          } catch {
            // Avatar upload failure is non-critical
          }
        }

        imported++;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        errors.push(`${entry.name}: ${reason}`);
      }
    }

    stAvatarFiles.current = new Map();
    setStImporting(false);
    setStImportProgress(null);
    setStImportPreview(null);

    await fetchBootstrapAction({ silent: true });
    await fetchPersonasAction();
    toast.success(t("st_persona_import_result", { count: imported }));
    if (errors.length > 0) {
      toast.warning(t("st_import_errors", { count: errors.length }));
    }
  }

  const triggers = (
    <>
      {importTooltipReady ? (
        <CustomTooltip content={t("st_persona_import_hint")}>
          <button type="button"
            className={cn("flex items-center justify-center gap-2 rounded-lg bg-s2 transition-all cursor-pointer font-ui font-medium", isMobile ? "min-h-[44px] flex-1 px-2 text-[14px]" : "h-[44px] px-4 text-sm")}
            style={{ color: "var(--t2)" }}
            onClick={() => stFileRef.current?.click()}
          >
            <Icons.Import /> {t("st_import_personas_btn")}
          </button>
        </CustomTooltip>
      ) : (
        <button type="button"
          className={cn("flex items-center justify-center gap-2 rounded-lg bg-s2 transition-all cursor-pointer font-ui font-medium", isMobile ? "min-h-[44px] flex-1 px-2 text-[14px]" : "h-[44px] px-4 text-sm")}
          style={{ color: "var(--t2)" }}
          onClick={() => stFileRef.current?.click()}
        >
          <Icons.Import /> {t("st_import_personas_btn")}
        </button>
      )}
      <CustomTooltip content={t("st_folder_import_hint")}>
        <button type="button"
          className={cn("flex items-center justify-center gap-2 rounded-lg bg-s2 transition-all cursor-pointer font-ui font-medium", isMobile ? "min-h-[44px] flex-1 px-2 text-[14px]" : "h-[44px] px-3 text-sm")}
          style={{ color: "var(--t2)" }}
          onClick={() => stFolderRef.current?.click()}
        >
          <Icons.Import /> {t("st_folder_import_btn")}
        </button>
      </CustomTooltip>
    </>
  );

  const preview = stImportPreview && (
    <div className={cn("shrink-0 rounded-lg border border-border2 bg-s2 mx-5 mb-2 p-4")}>
      <div className="font-ui text-sm font-medium text-t1 mb-2">{t("st_persona_preview_title", { count: stImportSelected.size })}</div>
      <div className="max-h-[200px] overflow-y-auto space-y-1.5">
        {stImportPreview.map((entry, idx) => (
          <div key={entry.key} className="flex items-start gap-2 rounded-md bg-surface px-3 py-2">
            <Checkbox
              checked={stImportSelected.has(entry.key)}
              onChange={() => {
                setStImportSelected(prev => {
                  const next = new Set(prev);
                  if (next.has(entry.key)) next.delete(entry.key);
                  else next.add(entry.key);
                  return next;
                });
              }}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-ui text-[13px] font-medium text-t1">{entry.name}</span>
              </div>
              {entry.description && (
                <div className="font-ui text-[12px] text-t3 line-clamp-2 mt-0.5">{entry.description.slice(0, 120)}{entry.description.length > 120 ? "..." : ""}</div>
              )}
            </div>
            <Checkbox
              checked={entry.isDefault}
              label={t("default_persona_badge")}
              onChange={() => {
                if (!stImportPreview) return;
                const updated = stImportPreview.map((e, i) => ({ ...e, isDefault: i === idx ? !e.isDefault : false }));
                setStImportPreview(updated);
              }}
            />
          </div>
        ))}
      </div>
      <div className="flex gap-2 mt-3">
        <button type="button"
          className="h-[34px] cursor-pointer rounded-md bg-accent px-4 font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-on-accent transition-all hover:brightness-110 disabled:opacity-45"
          disabled={stImporting || stImportSelected.size === 0}
          onClick={() => void handleStImport()}
        >
          {stImporting ? t("importing") : t("st_persona_confirm_import")}
        </button>
        <button type="button"
          className="h-[34px] cursor-pointer rounded-md px-3 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-all hover:text-t1"
          onClick={() => setStImportPreview(null)}
          disabled={stImporting}
        >
          {t("cancel_btn")}
        </button>
      </div>
      {stImporting && stImportProgress && (
        <div className="mt-2">
          <div className="h-1.5 overflow-hidden rounded-full bg-s3">
            <div
              className="h-full rounded-full bg-accent transition-all"
              style={{ width: `${(stImportProgress.current / stImportProgress.total) * 100}%` }}
            />
          </div>
          <div className="mt-1 font-ui text-[11px] text-t3">
            {t("st_persona_importing", { current: stImportProgress.current, total: stImportProgress.total })}
          </div>
        </div>
      )}
    </div>
  );

  const hiddenInputs = (
    <>
      {/* Hidden folder input for ST import */}
      <input
        ref={stFolderRef}
        className="hidden"
        type="file"
        webkitdirectory=""
        directory=""
        onChange={(e) => void handleStFolderPick(e.target.files)}
      />
      {/* Hidden single-file input — accepts a .json backup/export (VT-exported
          ST shape or raw ST settings.json). No avatars. */}
      <input
        ref={stFileRef}
        className="hidden"
        type="file"
        accept="application/json,.json"
        onChange={(e) => void handleStFilePick(e.target.files)}
      />
    </>
  );

  return { triggers, preview, hiddenInputs };
}
