import { useEffect, useMemo, useState } from "react";
import type { RegexScriptImportDraft } from "@vibe-tavern/import-export";
import { parseStandaloneRegexJson } from "@vibe-tavern/import-export";
import { useT } from "../../i18n/context.js";
import { cn } from "../../lib/cn.js";
import { lblCls } from "../../lib/field-tokens.js";
import type { CreateRegexProfileBundleBody, RegexProfileBundleRecord } from "../../api/regex-api.js";
import { Modal } from "../shared/Modal.js";
import { modalPanelCls } from "../shared/modal-helpers.js";
import { Icons } from "../shared/icons.js";
import { TextInput } from "../shared/text-input.js";
import { Toggle } from "../shared/Toggle.js";
import { SegmentedControl } from "../shared/SegmentedControl.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { summarizeRegexImportRules } from "./preset-import-flow.js";

type RegexImportScope = "preset" | "character" | "global" | "unbound";

interface RegexImportModalProps {
  file: File;
  currentPresetId: string | null;
  currentCharacterId: string | null;
  onClose: () => void;
  onImport: (body: CreateRegexProfileBundleBody) => Promise<RegexProfileBundleRecord>;
  onImported: (result: RegexProfileBundleRecord) => void;
}

/** Builds the one atomic Profile bundle from source-faithful standalone drafts. */
export function buildStandaloneRegexImportBundle(options: {
  name: string;
  rules: RegexScriptImportDraft[];
  scope: RegexImportScope;
  enableProfile: boolean;
  currentPresetId: string | null;
  currentCharacterId: string | null;
}): CreateRegexProfileBundleBody {
  const links = options.scope === "preset" && options.currentPresetId
    ? [{ targetType: "preset" as const, targetId: options.currentPresetId }]
    : options.scope === "character" && options.currentCharacterId
      ? [{ targetType: "character" as const, targetId: options.currentCharacterId }]
      : undefined;

  return {
    name: options.name,
    disabled: !options.enableProfile,
    isGlobal: options.scope === "global",
    ...(links ? { links } : {}),
    rules: options.rules.map((rule) => ({
      name: rule.name,
      findRegex: rule.findRegex,
      replaceString: rule.replaceString,
      trimStrings: [...rule.trimStrings],
      substituteRegex: rule.substituteRegex,
      disabled: rule.disabled,
      markdownOnly: rule.markdownOnly,
      promptOnly: rule.promptOnly,
      runOnEdit: rule.runOnEdit,
      minDepth: rule.minDepth,
      maxDepth: rule.maxDepth,
      placement: [...rule.placement],
      isGlobal: rule.isGlobal,
      sortOrder: rule.sortOrder,
    })),
  };
}

function defaultProfileName(file: File) {
  const withoutExtension = file.name.replace(/\.[^.]+$/, "").trim();
  return withoutExtension || "Imported Regex";
}

/** Preview and confirmation for one standalone Regex file.
 *  A scope must be chosen before its source-faithful Rules can be submitted
 *  together in one atomic Profile bundle. */
export function RegexImportModal({
  file,
  currentPresetId,
  currentCharacterId,
  onClose,
  onImport,
  onImported,
}: RegexImportModalProps) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const [rules, setRules] = useState<RegexScriptImportDraft[] | null>(null);
  const [profileName, setProfileName] = useState(() => defaultProfileName(file));
  const [scope, setScope] = useState<RegexImportScope | "">("");
  const [enableProfile, setEnableProfile] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    const reader = new FileReader();
    reader.onload = () => {
      if (!cancelled) setRules(parseStandaloneRegexJson(String(reader.result ?? "")));
    };
    reader.onerror = () => {
      if (!cancelled) setRules([]);
    };
    reader.readAsText(file);
    return () => { cancelled = true; };
  }, [file]);

  const counts = useMemo(() => summarizeRegexImportRules(rules ?? []), [rules]);
  const canSubmit = rules !== null && rules.length > 0 && profileName.trim().length > 0 && scope !== "" && !submitting;

  async function handleSubmit() {
    if (!rules || rules.length === 0 || !scope || !profileName.trim()) return;
    setSubmitting(true);
    setError("");
    try {
      const result = await onImport(buildStandaloneRegexImportBundle({
        name: profileName.trim(),
        rules,
        scope,
        enableProfile,
        currentPresetId,
        currentCharacterId,
      }));
      onImported(result);
      onClose();
    } catch {
      setError(t("regexImport.bundleFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  const scopeOptions = [
    { value: "preset" as const, label: t("regexImport.scopeCurrentPreset"), disabled: !currentPresetId },
    { value: "character" as const, label: t("regexImport.scopeCurrentCharacter"), disabled: !currentCharacterId },
    { value: "global" as const, label: t("regexImport.scopeAllChats") },
    { value: "unbound" as const, label: t("regexImport.scopeUnbound") },
  ];

  return (
    <Modal open={true} onClose={onClose}>
      <div className={cn(
        "flex flex-col",
        isMobile
          ? "glass-blur-under h-full w-full overflow-hidden"
          : cn(modalPanelCls, "max-h-[calc(100vh-60px)] w-[640px] max-w-[calc(100vw-32px)]"),
      )}>
        <div className="shrink-0 px-5 pt-[18px] pb-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="font-body text-[calc(var(--ui-fs)+4px)] font-medium text-t1">{t("regexImport.title")}</div>
              <div className="mt-0.5 font-ui text-[calc(var(--ui-fs)-2px)] text-t3">{file.name}</div>
            </div>
            <button type="button" aria-label={t("close")} className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-[5px] text-t3 transition-all hover:bg-s2 hover:text-t1" onClick={onClose}><Icons.Close /></button>
          </div>
        </div>

        {rules === null ? (
          <div className="px-5 py-8 font-ui text-[calc(var(--ui-fs)-2px)] text-t3">{t("loading")}</div>
        ) : rules.length === 0 ? (
          <div className="px-5 py-8 font-ui text-[calc(var(--ui-fs)-2px)] text-t3">{t("regexImport.emptyFile")}</div>
        ) : (
          <div className="min-h-0 overflow-y-auto border-y border-border px-5 py-4">
            <label className="block">
              <span className={lblCls}>{t("regexImport.profileName")}</span>
              <TextInput value={profileName} onChange={(event) => setProfileName(event.target.value)} />
            </label>
            <div className="mt-4 font-ui text-[calc(var(--ui-fs)-2px)] text-t3">
              {t("regexImport.profileSummary", { n: counts.total, enabled: counts.enabled, disabled: counts.disabled })}
            </div>
            <button type="button" className="mt-2 cursor-pointer font-ui text-[calc(var(--ui-fs)-3px)] text-accent hover:underline" onClick={() => setExpanded(!expanded)}>
              {expanded ? t("regexImport.hideRules") : t("regexImport.showRules")}
            </button>
            {expanded && (
              <ul className="mt-1.5 flex flex-col gap-1">
                {rules.map((rule, index) => (
                  <li key={`${rule.name}-${index}`} className="flex items-center gap-2 font-ui text-[calc(var(--ui-fs)-2px)] text-t3">
                    <div className={cn("h-1.5 w-1.5 shrink-0 rounded-full", rule.disabled ? "bg-t4" : "bg-accent")} />
                    <span className="truncate">{rule.name}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-5">
              <div className="mb-1.5 font-ui text-[calc(var(--ui-fs)-3px)] text-t2">{t("regexImport.scopeLabel")}</div>
              <SegmentedControl
                value={scope}
                options={scopeOptions}
                onChange={setScope}
                ariaLabel={t("regexImport.scopeLabel")}
                mobileScroll
              />
              {!currentPresetId && <div className="mt-1.5 font-ui text-[calc(var(--ui-fs)-3px)] text-t3">{t("regexImport.scopePresetUnavailable")}</div>}
              {!currentCharacterId && <div className="mt-1 font-ui text-[calc(var(--ui-fs)-3px)] text-t3">{t("regexImport.scopeCharacterUnavailable")}</div>}
            </div>
            <div className="mt-5 flex items-center justify-between gap-3">
              <label htmlFor="regex-import-enable" className="cursor-pointer select-none font-ui text-[calc(var(--ui-fs)-2px)] text-t2">{t("regexImport.enableAfterImport")}</label>
              <Toggle id="regex-import-enable" checked={enableProfile} onChange={setEnableProfile} />
            </div>
            {error && <div role="alert" className="mt-3 font-ui text-[calc(var(--ui-fs)-2px)] text-danger">{error}</div>}
          </div>
        )}

        <div className="flex shrink-0 items-center justify-between border-t border-border px-5 py-3.5">
          <button type="button" className="h-[37px] cursor-pointer rounded-md bg-transparent py-0 px-4 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-all hover:text-t1" onClick={onClose}>{t("cancel")}</button>
          <button type="button" className="h-[37px] cursor-pointer rounded-md bg-accent py-0 px-[21px] font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-on-accent transition-all hover:brightness-110 disabled:opacity-50" disabled={!canSubmit} onClick={() => void handleSubmit()}>
            {t("regexImport.importButton", { n: counts.total })}
          </button>
        </div>
      </div>
    </Modal>
  );
}
