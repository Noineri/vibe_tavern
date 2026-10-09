import { useEffect, useMemo, useState } from "react";
import { useT } from "../../../i18n/context.js";
import { Toggle } from "../../shared/Toggle.js";
import { SegmentedControl } from "../../shared/SegmentedControl.js";
import { LinkBindingPopover, type LinkBindingRecord, type LinkTarget } from "../../shared/LinkBindingPopover.js";
import { characterToLinkTarget, promptPresetToLinkTarget } from "../../../lib/link-targets.js";
import { lblCls } from "../../../lib/field-tokens.js";
import { TextInput } from "../../shared/text-input.js";
import { useIsMobile } from "../../../hooks/use-mobile.js";
import { useAllCharacters } from "../../../stores/snapshot-store.js";
import { getRegexProfileLinks, setRegexProfileLinks } from "../../../api/regex-api.js";
import { listPromptPresets } from "../../../api/preset-api.js";
import { invalidateActiveRegexPresets } from "../../../hooks/use-active-regex-presets.js";
import type { RegexPresetRecord, RegexProfileRecord } from "../../../api/types.js";
import { RegexProfileRulePicker } from "./RegexProfileRulePicker.js";
import { AddButton } from "../../shared/add-button.js";
import { EmptyState } from "../../shared/empty-state.js";
import { Icons, Ic } from "../../shared/icons.js";

const SCOPE_OPTIONS = [
  { value: "all", labelKey: "promptManager.regex.scopeAll" as const },
  { value: "bind", labelKey: "promptManager.regex.scopeBind" as const },
] as const;

interface RegexProfileEditorProps {
  profile: RegexProfileRecord;
  memberCount: number;
  rules: RegexPresetRecord[];
  onCreateRule: () => void;
  onAttachRules: (ruleIds: string[]) => void;
  onNameChange: (nextName: string) => void;
  onActiveToggle: (nextActive: boolean) => void;
  onScopeChange: (nextIsGlobal: boolean) => void;
  onLinksChanged?: (profileId: string, count: number) => void;
}

function ProfileMemberActions({
  rules,
  onCreateRule,
  onAttachRules,
}: Pick<RegexProfileEditorProps, "rules" | "onCreateRule" | "onAttachRules">) {
  const { t } = useT();
  return (
    <div className="flex flex-wrap gap-2">
      <AddButton prominent onClick={onCreateRule}>
        <Ic.plus />
        {t("promptManager.regex.createRule")}
      </AddButton>
      <RegexProfileRulePicker rules={rules} onAttach={onAttachRules} onCancel={() => {}} />
    </div>
  );
}

export function RegexProfileEditor({
  profile,
  memberCount,
  rules,
  onCreateRule,
  onAttachRules,
  onNameChange,
  onActiveToggle,
  onScopeChange,
  onLinksChanged,
}: RegexProfileEditorProps) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const [name, setName] = useState(profile.name);

  useEffect(() => {
    setName(profile.name);
  }, [profile.id, profile.name]);


  // ── Bindings ──
  const allCharacters = useAllCharacters();
  const [bindLinks, setBindLinks] = useState<LinkBindingRecord[]>([]);
  const [promptPresets, setPromptPresets] = useState<Array<{ id: string; name: string; updatedAt?: string }>>([]);

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
        if (!cancelled) setPromptPresets(list.map((p) => ({ id: p.id, name: p.name, updatedAt: p.updatedAt })));
      })
      .catch(() => {
        if (!cancelled) setPromptPresets([]);
      });
    return () => {
      cancelled = true;
    };
  }, [profile.id]);

  const characterTargets: LinkTarget[] = useMemo(
    () => allCharacters.map(characterToLinkTarget),
    [allCharacters],
  );
  const presetTargets: LinkTarget[] = useMemo(
    () => promptPresets.map(promptPresetToLinkTarget),
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
    <div className="flex flex-col gap-4" data-testid="regex-profile-editor">
      {/* Name + Active toggle */}
      <div className="flex items-end gap-4">
        <div className="min-w-0 flex-1">
          <label className={lblCls} htmlFor="regex-profile-name">
            {t("promptManager.regex.fieldName")}
          </label>
          <TextInput
            id="regex-profile-name"
            value={name}
            onChange={(e) => {
              const nextName = e.target.value;
              setName(nextName);
              const trimmed = nextName.trim();
              if (trimmed) onNameChange(trimmed);
            }}
            onKeyDown={(e) => {
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
          mobileSelect
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

      {memberCount === 0 ? (
        <div className="flex flex-col gap-3" data-testid="regex-profile-members-empty-state">
          <EmptyState
            icon={<Icons.Terminal />}
            title={t("promptManager.regex.profileMembersEmptyTitle")}
            sub={t("promptManager.regex.profileMembersEmptySub")}
          />
          <ProfileMemberActions rules={rules} onCreateRule={onCreateRule} onAttachRules={onAttachRules} />
        </div>
      ) : (
        <>
          <div className="font-ui text-[calc(var(--ui-fs)-2px)] text-t3">
            {t("promptManager.regex.profileMemberCount", { count: memberCount })}
          </div>
          <ProfileMemberActions rules={rules} onCreateRule={onCreateRule} onAttachRules={onAttachRules} />
        </>
      )}

    </div>
  );
}
