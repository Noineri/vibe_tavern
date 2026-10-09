import { useEffect, useMemo, useState } from "react";
import { useT } from "../../../i18n/context.js";
import { Toggle } from "../../shared/Toggle.js";
import { SegmentedControl } from "../../shared/SegmentedControl.js";
import { LinkBindingPopover, type LinkBindingRecord, type LinkTarget } from "../../shared/LinkBindingPopover.js";
import { characterToLinkTarget, promptPresetToLinkTarget, regexToLinkTarget } from "../../../lib/link-targets.js";
import { lblCls } from "../../../lib/field-tokens.js";
import { TextInput } from "../../shared/text-input.js";
import { useIsMobile } from "../../../hooks/use-mobile.js";
import { useAllCharacters } from "../../../stores/snapshot-store.js";
import { getRegexProfileLinks, setRegexProfileLinks } from "../../../api/regex-api.js";
import { listPromptPresets } from "../../../api/preset-api.js";
import { invalidateActiveRegexPresets } from "../../../hooks/use-active-regex-presets.js";
import type { RegexPresetRecord, RegexProfileRecord } from "../../../api/types.js";
import { regexProfileAvailability } from "../../../lib/regex-availability.js";
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
  onDetachRules: (ruleIds: string[]) => void;
  onNameChange: (nextName: string) => void;
  onActiveToggle: (nextActive: boolean) => void;
  onScopeChange: (nextIsGlobal: boolean) => void;
  onLinksChanged?: (profileId: string, count: number) => void;
}

function ProfileMemberActions({
  memberLinks,
  ruleTargets,
  onCreateRule,
  onSetMemberLinks,
}: Pick<RegexProfileEditorProps, "onCreateRule"> & {
  memberLinks: LinkBindingRecord[];
  ruleTargets: LinkTarget[];
  onSetMemberLinks: (next: LinkBindingRecord[]) => void;
}) {
  const { t } = useT();
  const isMobile = useIsMobile();
  return (
    <div className="flex flex-wrap gap-2">
      <AddButton prominent onClick={onCreateRule}>
        <Ic.plus />
        {t("promptManager.regex.createRule")}
      </AddButton>
      {/* Owner ruling 2026-10-09: «Add existing» rides the shared
          LinkBindingPopover — NO forked picker (the RXU-41 fork duplicated
          the primitive one-to-one). showPills=false: the member ROWS live in
          the left list, this surface is the add trigger + picker only (the
          Dice assignment-row precedent). Immediate per-toggle membership —
          the lorebook-pill canon; toggling an active member chip detaches
          it back to Standalone. */}
      <LinkBindingPopover
        links={memberLinks}
        characters={[]}
        personas={[]}
        presets={[]}
        regexes={ruleTargets}
        onSetLinks={onSetMemberLinks}
        t={t}
        isMobile={isMobile}
        showPills={false}
        triggerLabel={t("promptManager.regex.pickerTrigger")}
        tooltipLabel={t("promptManager.regex.pickerTitle")}
        emptyLabel={t("promptManager.regex.pickerEmptySub")}
      />
    </div>
  );
}

export function RegexProfileEditor({
  profile,
  memberCount,
  rules,
  onCreateRule,
  onAttachRules,
  onDetachRules,
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
  const [linksLoaded, setLinksLoaded] = useState(false);
  const [promptPresetsLoaded, setPromptPresetsLoaded] = useState(false);
  const [promptPresets, setPromptPresets] = useState<Array<{ id: string; name: string; updatedAt?: string }>>([]);

  useEffect(() => {
    setBindLinks([]);
    setLinksLoaded(false);
    setPromptPresetsLoaded(false);
    let cancelled = false;
    getRegexProfileLinks(profile.id)
      .then((rows) => {
        if (!cancelled) { setBindLinks(rows.map((r) => ({ targetType: r.targetType, targetId: r.targetId }))); setLinksLoaded(true); }
      })
      .catch(() => {
        if (!cancelled) { setBindLinks([]); setLinksLoaded(true); }
      });
    listPromptPresets()
      .then((list) => {
        if (!cancelled) {
          setPromptPresets(list.map((promptPreset) => ({ id: promptPreset.id, name: promptPreset.name, updatedAt: promptPreset.updatedAt })));
          setPromptPresetsLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) { setPromptPresets([]); setPromptPresetsLoaded(true); }
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

  // RXU-31 is the sole availability derivation. Unbound means enabled,
  // non-global, and CONFIRMED zero resolvable links; until links and prompt
  // preset targets resolve, undefined yields loading and no false red reason.
  const profileAvailability = regexProfileAvailability(
    profile,
    [],
    linksLoaded && promptPresetsLoaded ? effectiveBindCount : undefined,
  );
  const isUnbound = profileAvailability.kind === "unbound";

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

  // ── Member pick via the shared LinkBindingPopover (immediate toggles).
  // Targets = attach candidates (Standalone Rules) + this Profile's own
  // members (so an active chip can be toggled OFF back to Standalone);
  // other Profiles' members never appear here.
  const memberLinks: LinkBindingRecord[] = useMemo(
    () => rules
      .filter((r) => r.profileId === profile.id)
      .map((r) => ({ targetType: "regex" as const, targetId: r.id })),
    [rules, profile.id],
  );
  const ruleTargets: LinkTarget[] = useMemo(
    () => rules
      .filter((r) => r.profileId === null || r.profileId === profile.id)
      .map(regexToLinkTarget),
    [rules, profile.id],
  );
  const handleSetMemberLinks = (next: LinkBindingRecord[]) => {
    const currentIds = new Set(memberLinks.map((l) => l.targetId));
    const nextIds = new Set(
      next.filter((l) => l.targetType === "regex").map((l) => l.targetId),
    );
    const added = [...nextIds].filter((id) => !currentIds.has(id));
    const removed = [...currentIds].filter((id) => !nextIds.has(id));
    if (added.length > 0) onAttachRules(added);
    if (removed.length > 0) onDetachRules(removed);
  };

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

      {isUnbound && (
        <div className="-mt-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-danger/40 bg-danger/10 px-2 py-px font-ui text-[calc(var(--ui-fs)-4px)] leading-tight text-danger-text select-none">
            <span className="h-[6px] w-[6px] rounded-full bg-danger" />
            {t("promptManager.regex.availabilityUnbound")}
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
          <ProfileMemberActions
            memberLinks={memberLinks}
            ruleTargets={ruleTargets}
            onCreateRule={onCreateRule}
            onSetMemberLinks={handleSetMemberLinks}
          />
        </div>
      ) : (
        <>
          <div className="font-ui text-[calc(var(--ui-fs)-2px)] text-t3">
            {t("promptManager.regex.profileMemberCount", { count: memberCount })}
          </div>
          <ProfileMemberActions
            memberLinks={memberLinks}
            ruleTargets={ruleTargets}
            onCreateRule={onCreateRule}
            onSetMemberLinks={handleSetMemberLinks}
          />
        </>
      )}

    </div>
  );
}
