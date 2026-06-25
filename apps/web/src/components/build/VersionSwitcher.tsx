import { useEffect, useMemo, useState, type ReactNode } from "react";
import { cn } from "../../lib/cn.js";
import { useT } from "../../i18n/context.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { Ic } from "../shared/icons.js";
import { SegmentedControl } from "../shared/SegmentedControl.js";
import { DropdownSelect } from "../shared/DropdownSelect.js";
import { ActionSheet } from "../shared/ActionSheet.js";
import { DestructiveConfirmModal } from "../shared/destructive-confirm-modal.js";
import { toast } from "sonner";
import {
  activateCharacterVersionAction,
  createCharacterVersionAction,
  deleteCharacterVersionAction,
  listCharacterVersionsAction,
  renameCharacterVersionAction,
} from "../../stores/api-actions/character-actions.js";
import type { AppCharacterVersion } from "../../api/types.js";

const DROPDOWN_THRESHOLD = 6; // >5 versions → dropdown
const NEW_VERSION_DEFAULT = "New version";

interface VersionSwitcherProps {
  characterId: string;
  /** True when the editor draft has unsaved edits. Switching then needs a confirm. */
  isDirty: boolean;
  disabled?: boolean;
  /** Called after a version is activated; the parent resets its editor draft from the reloaded character. */
  onAfterActivate: () => void;
}

/**
 * Vibe Tavern Format Phase 3 — character version switcher.
 *
 * Mounted under the tags block in CharacterForm (shared across Form/MD modes).
 * Surfaces branching (parallel editable variants) with three layouts:
 *  - Mobile: a button opening an {@link ActionSheet} (one row per version + a "new" row).
 *  - Desktop ≤5 versions: a wrapping {@link SegmentedControl} + a "+ new" chip,
 *    with rename/delete icons on hover for non-active versions.
 *  - Desktop >5 versions: a {@link DropdownSelect} (the segmented row would wrap
 *    too far) with a "+ new version" chip.
 *
 * Switching the active version reloads the character snapshot (the active
 * version's content lives at the folder root). When the editor is dirty, the
 * switch is gated behind a destructive confirm — unsaved edits would be lost.
 */
export function VersionSwitcher({ characterId, isDirty, disabled, onAfterActivate }: VersionSwitcherProps) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const [versions, setVersions] = useState<AppCharacterVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  // Pending action awaiting a dirty-switch confirm.
  const [pendingSwitchId, setPendingSwitchId] = useState<string | null>(null);
  // Pending delete (always confirmed, dirty or not).
  const [pendingDelete, setPendingDelete] = useState<AppCharacterVersion | null>(null);
  // Inline rename.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listCharacterVersionsAction(characterId)
      .then((list) => { if (!cancelled) setVersions(list); })
      .catch(() => { if (!cancelled) setVersions([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [characterId]);

  const active = versions.find((v) => v.isActive) ?? null;
  const useDropdown = versions.length >= DROPDOWN_THRESHOLD;

  // Ordinal label by creation order: v1 "Base", v2 "Aggressive", ...
  const labelFor = useMemo(() => {
    const sorted = [...versions].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const index = new Map<string, number>();
    sorted.forEach((v, i) => index.set(v.id, i + 1));
    return (v: AppCharacterVersion) => `v${index.get(v.id) ?? "?"} · ${v.title}`;
  }, [versions]);

  async function refresh(): Promise<void> {
    const list = await listCharacterVersionsAction(characterId);
    setVersions(list);
  }

  async function handleBranch(title: string): Promise<void> {
    setBusy(true);
    try {
      await createCharacterVersionAction(characterId, title);
      await refresh();
      toast.success(t("version_branch"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("version_branch"));
    } finally {
      setBusy(false);
    }
  }

  function requestActivate(versionId: string): void {
    if (disabled || busy) return;
    if (versionId === active?.id) return;
    // Dirty editor: gate the switch behind a confirm (unsaved edits would be lost).
    if (isDirty) {
      setPendingSwitchId(versionId);
      return;
    }
    void doActivate(versionId);
  }

  async function doActivate(versionId: string): Promise<void> {
    setBusy(true);
    try {
      await activateCharacterVersionAction(characterId, versionId);
      await refresh();
      onAfterActivate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("version_switch"));
    } finally {
      setBusy(false);
    }
  }

  async function doDelete(version: AppCharacterVersion): Promise<void> {
    setBusy(true);
    try {
      await deleteCharacterVersionAction(characterId, version.id);
      await refresh();
      toast.success(t("version_delete"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("version_delete"));
    } finally {
      setBusy(false);
    }
  }

  function startRename(v: AppCharacterVersion): void {
    setRenamingId(v.id);
    setRenameValue(v.title);
  }

  async function commitRename(): Promise<void> {
    const id = renamingId;
    const title = renameValue.trim();
    setRenamingId(null);
    if (!id || !title || title === versions.find((v) => v.id === id)?.title) return;
    setBusy(true);
    try {
      await renameCharacterVersionAction(characterId, id, title);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("version_rename"));
    } finally {
      setBusy(false);
    }
  }

  function promptNewVersion(): void {
    const title = window.prompt(t("version_new_prompt"), t("version_new_title") || NEW_VERSION_DEFAULT);
    if (title?.trim()) void handleBranch(title.trim());
  }

  const renameAffordances = !isMobile && !useDropdown ? (
    <DeleteRenameAffordances
      versions={versions}
      active={active}
      renamingId={renamingId}
      renameValue={renameValue}
      onStartRename={startRename}
      onRenameValueChange={setRenameValue}
      onCommitRename={commitRename}
      onCancelRename={() => setRenamingId(null)}
      onRequestDelete={(v) => setPendingDelete(v)}
      disabled={!!disabled || busy}
    />
  ) : null;

  const deleteConfirm = pendingDelete ? (
    <DestructiveConfirmModal
      title={t("version_delete_title")}
      body={t("version_delete_body").replace("{title}", pendingDelete.title)}
      confirmLabel={t("delete")}
      onConfirm={() => { const v = pendingDelete; setPendingDelete(null); void doDelete(v); }}
      onCancel={() => setPendingDelete(null)}
    />
  ) : null;

  const switchConfirm = pendingSwitchId ? (
    <DestructiveConfirmModal
      title={t("version_switch_dirty_title")}
      body={t("version_switch_dirty_body")}
      confirmLabel={t("version_switch_confirm")}
      onConfirm={() => { const id = pendingSwitchId; setPendingSwitchId(null); if (id) void doActivate(id); }}
      onCancel={() => setPendingSwitchId(null)}
    />
  ) : null;

  // ── Mobile: button → ActionSheet ─────────────────────────────────────────
  if (isMobile) {
    return (
      <>
        <div className="flex items-center gap-2">
          <button type="button"
            className="flex min-h-[36px] flex-1 cursor-pointer items-center gap-2 rounded-md border border-border bg-s2 px-3 text-[13px] text-t1 transition-colors hover:border-accent disabled:opacity-40"
            onClick={() => setSheetOpen(true)}
            disabled={!!disabled || loading}
          >
            <span className="truncate">{loading || !active ? t("version_label") : labelFor(active)}</span>
            <span className="ml-auto text-t3">{Ic.caret("d")}</span>
          </button>
        </div>
        <ActionSheet
          open={sheetOpen}
          title={t("version_label")}
          onClose={() => setSheetOpen(false)}
          items={[
            ...versions.map((v) => ({
              icon: v.isActive
                ? <span className="text-[13px] font-bold text-accent-t">✓</span>
                : <span className="w-[11px]" />,
              label: labelFor(v),
              action: () => requestActivate(v.id),
            })),
            {
              icon: Ic.plus(),
              label: t("version_branch"),
              action: promptNewVersion,
            },
          ]}
        />
        {switchConfirm}
        {deleteConfirm}
      </>
    );
  }

  // ── Desktop >5: DropdownSelect ───────────────────────────────────────────
  if (useDropdown) {
    return (
      <Wrap disabled={!!disabled || busy || loading}>
        <div className="flex items-center gap-2">
          <DropdownSelect
            value={active?.id ?? ""}
            options={versions.map((v) => ({ id: v.id, label: labelFor(v) }))}
            onChange={(id) => requestActivate(id)}
            disabled={!!disabled || busy}
            searchable={false}
            className="min-w-[200px]"
          />
          <NewVersionButton onClick={promptNewVersion} busy={busy} disabled={!!disabled} />
        </div>
        {deleteConfirm}
        {switchConfirm}
      </Wrap>
    );
  }

  // ── Desktop ≤5: SegmentedControl (wrap) + hover edit/delete ──────────────
  const segments = versions.map((v) => ({ value: v.id, label: labelFor(v) }));
  return (
    <Wrap disabled={!!disabled || busy || loading}>
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl
          value={active?.id ?? ""}
          options={segments}
          onChange={(id) => requestActivate(id)}
          wrap
          compact
          disabled={!!disabled || busy}
        />
        <NewVersionButton onClick={promptNewVersion} busy={busy} disabled={!!disabled} />
      </div>
      {renameAffordances}
      {deleteConfirm}
      {switchConfirm}
    </Wrap>
  );
}

/** "+ new version" chip. */
function NewVersionButton({ onClick, busy, disabled }: { onClick: () => void; busy: boolean; disabled: boolean }) {
  const { t } = useT();
  return (
    <button type="button"
      className="flex h-8 cursor-pointer items-center gap-1 rounded-full border border-dashed border-border bg-transparent px-3 font-ui text-[12px] text-t2 transition-all hover:border-accent hover:text-accent-t disabled:opacity-40"
      disabled={busy || disabled}
      onClick={onClick}
      title={t("version_branch")}
    >
      {Ic.plus()}
      <span>{t("version_branch")}</span>
    </button>
  );
}

/** Rename (inline input) + delete (icon) rows for non-active versions, shown below the switcher. */
function DeleteRenameAffordances(props: {
  versions: AppCharacterVersion[];
  active: AppCharacterVersion | null;
  renamingId: string | null;
  renameValue: string;
  onStartRename: (v: AppCharacterVersion) => void;
  onRenameValueChange: (value: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onRequestDelete: (v: AppCharacterVersion) => void;
  disabled: boolean;
}): ReactNode {
  const { t } = useT();
  const editable = props.versions.filter((v) => v.id !== props.active?.id);
  if (editable.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5 pl-0.5">
      {editable.map((v) => (
        <div key={v.id} className="group/version flex items-center gap-1.5">
          {props.renamingId === v.id ? (
            <input
              autoFocus
              value={props.renameValue}
              onChange={(e) => props.onRenameValueChange(e.target.value)}
              className="h-6 w-32 rounded border border-accent bg-s2 px-1.5 font-ui text-[12px] text-t1 outline-none"
              onKeyDown={(e) => { if (e.key === "Enter") props.onCommitRename(); if (e.key === "Escape") props.onCancelRename(); }}
              onBlur={() => props.onCommitRename()}
            />
          ) : (
            <span className="font-ui text-[11px] text-t3">{v.title}</span>
          )}
          <button type="button"
            className="flex h-5 w-5 cursor-pointer items-center justify-center rounded text-t3 opacity-0 transition-opacity hover:bg-s3 hover:text-t1 group-hover/version:opacity-100 disabled:opacity-0"
            onClick={() => props.onStartRename(v)}
            disabled={props.disabled}
            title={t("version_rename")}
            aria-label={t("version_rename")}
          >
            {Ic.edit()}
          </button>
          <button type="button"
            className="flex h-5 w-5 cursor-pointer items-center justify-center rounded text-t3 opacity-0 transition-opacity hover:bg-s3 hover:text-danger-text group-hover/version:opacity-100 disabled:opacity-0"
            onClick={() => props.onRequestDelete(v)}
            disabled={props.disabled}
            title={t("version_delete")}
            aria-label={t("version_delete")}
          >
            {Ic.del()}
          </button>
        </div>
      ))}
    </div>
  );
}

/** Wraps the switcher in a labelled column with a loading/disabled state. */
function Wrap({ children, disabled }: { children: ReactNode; disabled: boolean }) {
  return (
    <div className={cn("flex flex-col gap-0.5", disabled && "pointer-events-none opacity-60")}>
      {children}
    </div>
  );
}
