import { useEffect, useMemo, useState } from "react";
import { useT } from "../../../i18n/context.js";
import { Toggle } from "../../shared/Toggle.js";
import { SegmentedControl } from "../../shared/SegmentedControl.js";
import { LinkBindingPopover, type LinkBindingRecord, type LinkTarget } from "../../shared/LinkBindingPopover.js";
import { inputCls, lblCls } from "../../build/fields/field-styles.js";
import { useIsMobile } from "../../../hooks/use-mobile.js";
import { useAllCharacters } from "../../../stores/snapshot-store.js";
import { getRegexProfileLinks, setRegexProfileLinks } from "../../../api/regex-api.js";
import { listPromptPresets } from "../../../api/preset-api.js";
import { invalidateActiveRegexPresets } from "../../../hooks/use-active-regex-presets.js";
import type { RegexProfileRecord } from "../../../api/types.js";
import { Icons } from "../../shared/icons.js";

const SCOPE_OPTIONS = [
  { value: "all", labelKey: "promptManager.regex.scopeAll" as const },
  { value: "bind", labelKey: "promptManager.regex.scopeBind" as const },
] as const;

interface RegexProfileEditorProps {
  profile: RegexProfileRecord;
  memberCount: number;
  onNameCommit: (newName: string) => void;
  onActiveToggle: (nextActive: boolean) => void;
  onScopeChange: (nextIsGlobal: boolean) => void;
  onLinksChanged?: (profileId: string, count: number) => void;
  onExport: () => void;
  onDeleteClick: () => void;
}

export function RegexProfileEditor({
  profile,
  memberCount,
  onNameCommit,
  onActiveToggle,
  onScopeChange,
  onLinksChanged,
  onExport,
  onDeleteClick,
}: RegexProfileEditorProps) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const [name, setName] = useState(profile.name);

  useEffect(() => {
    setName(profile.name);
  }, [profile.id, profile.name]);

  const commitName = () => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== profile.name) onNameCommit(trimmed);
    else setName(profile.name);
  };

  // ── Bindings ──
  const allCharacters = useAllCharacters();
  const [bindLinks, setBindLinks] = useState<LinkBindingRecord[]>([]);
  const [promptPresets, setPromptPresets] = useState<Array<{ id: string; name: string }>>([]);

  useEffect(() => {
    setBindLinks([]);
    let cancelled = false;
    getRegexProfileLinks(profile.id)
      .then((rows) => {
        if (!cancelled) setBindLinks(rows.map((r) => ({ targetType: r.targetType, targetId: r.targetId })));
      })
      .catch(() => {
        if (!cancelled) setBindLinks([]);
      });
    listPromptPresets()
      .then((list) => {
        if (!cancelled) setPromptPresets(list.map((p) => ({ id: p.id, name: p.name })));
      })
      .catch(() => {
        if (!cancelled) setPromptPresets([]);
      });
    return () => {
      cancelled = true;
    };
  }, [profile.id]);

  const characterTargets: LinkTarget[] = useMemo(
    () =>
      allCharacters.map((c) => ({
        id: c.id,
        name: c.name,
        avatarAssetId: c.avatarAssetId,
        kind: "characters" as const,
        avatarExt: c.avatarExt,
        avatarFullExt: c.avatarFullExt,
        avatarFullAssetId: c.avatarFullAssetId,
        updatedAt: c.updatedAt,
      })),
    [allCharacters],
  );
  const presetTargets: LinkTarget[] = useMemo(
    () => promptPresets.map((p) => ({ id: p.id, name: p.name, avatarAssetId: null })),
    [promptPresets],
  );

  const resolvableIds = useMemo(() => {
    const ids = new Set<string>();
    for (const c of characterTargets) ids.add(c.id);
    for (const p of presetTargets) ids.add(p.id);
    return ids;
  }, [characterTargets, presetTargets]);

  const effectiveBindCount = useMemo(
    () => bindLinks.filter((l) => resolvableIds.has(l.targetId)).length,
    [bindLinks, resolvableIds],
  );

  const notApplied = !profile.isGlobal && !profile.disabled && effectiveBindCount === 0;

  const handleSetBindLinks = (next: LinkBindingRecord[]) => {
    const prev = bindLinks;
    setBindLinks(next);
    // Profile links accept only character|preset targets — narrow at the API
    // boundary (the popover only offers those sections here anyway).
    const payload = next
      .filter((l): l is LinkBindingRecord & { targetType: "character" | "preset" } =>
        l.targetType === "character" || l.targetType === "preset")
      .map((l) => ({ targetType: l.targetType, targetId: l.targetId }));
    setRegexProfileLinks(profile.id, payload)
      .then((rows) => {
        invalidateActiveRegexPresets();
        onLinksChanged?.(profile.id, rows.length);
      })
      .catch(() => setBindLinks(prev));
  };

  const isActive = !profile.disabled;

  return (
    <div className="flex flex-col gap-4">
      {/* Name + Active toggle */}
      <div className="flex items-end gap-4">
        <div className="min-w-0 flex-1">
          <label className={lblCls} htmlFor="regex-profile-name">
            {t("promptManager.regex.fieldName")}
          </label>
          <input
            id="regex-profile-name"
            type="text"
            className={inputCls}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitName();
              if (e.key === "Escape") setName(profile.name);
            }}
            placeholder={t("promptManager.regex.newProfilePlaceholder")}
          />
        </div>
        <div className="flex shrink-0 items-center gap-2 pb-[7px]">
          <Toggle id="regex-profile-active" checked={isActive} onChange={onActiveToggle} />
          <label htmlFor="regex-profile-active" className="cursor-pointer font-ui text-[calc(var(--ui-fs)-1px)] text-t2 select-none">
            {t("promptManager.regex.fieldActive")}
          </label>
        </div>
      </div>

      {notApplied && (
        <div className="-mt-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-danger/40 bg-danger/10 px-2 py-px font-ui text-[calc(var(--ui-fs)-4px)] leading-tight text-danger-text select-none">
            <span className="h-[6px] w-[6px] rounded-full bg-danger" />
            {t("promptManager.regex.badgeNotApplied")}
          </span>
        </div>
      )}

      {/* Scope */}
      <div>
        <div className={lblCls}>{t("promptManager.regex.scopeLabel")}</div>
        <SegmentedControl
          value={profile.isGlobal ? "all" : "bind"}
          onChange={(v) => onScopeChange(v === "all")}
          wrap
          mobileFill
          options={SCOPE_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
        />
      </div>

      {/* Bindings — shown only in bind mode */}
      {!profile.isGlobal && (
        <div>
          <div className={lblCls}>{t("promptManager.regex.bindingsLabel")}</div>
          <LinkBindingPopover
            links={bindLinks}
            characters={characterTargets}
            personas={[]}
            presets={presetTargets}
            onSetLinks={handleSetBindLinks}
            t={t}
            isMobile={isMobile}
            tooltipLabel={t("promptManager.regex.bindingsAdd")}
            emptyLabel={t("promptManager.regex.bindingsEmpty")}
            characterSectionLabel={t("promptManager.regex.sectionCharacters")}
            presetSectionLabel={t("promptManager.regex.sectionPresets")}
          />
          {effectiveBindCount === 0 && (
            <div className="mt-1.5 font-ui text-[11px] text-warning">
              {t("promptManager.regex.bindingsDeadZone")}
            </div>
          )}
        </div>
      )}

      {/* Member count hint */}
      <div className="font-ui text-[calc(var(--ui-fs)-2px)] text-t3">
        {t("promptManager.regex.profileMemberCount", { count: memberCount })}
      </div>

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onExport}
          disabled={memberCount === 0}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-s2 px-3 py-1.5 font-ui text-[calc(var(--ui-fs)-2px)] text-t2 transition-colors hover:bg-s3 hover:text-t1 disabled:opacity-40 disabled:pointer-events-none"
        >
          <Icons.Download />
          {t("promptManager.regex.profileExport")}
        </button>
        <button
          type="button"
          onClick={onDeleteClick}
          className="inline-flex items-center gap-1.5 rounded-md border border-danger/40 bg-danger/10 px-3 py-1.5 font-ui text-[calc(var(--ui-fs)-2px)] text-danger transition-colors hover:bg-danger/20"
        >
          <Icons.Trash />
          {t("promptManager.regex.profileDelete")}
        </button>
      </div>
    </div>
  );
}
