/**
 * SetupWizard — first-run wizard with two paths:
 *   Path A: "Начать настройку" (provider → persona → character)
 *   Path B: "Переезд из SillyTavern" (ST bulk import → provider)
 */
import { useState, useCallback, useEffect, useRef } from "react";
import { useT } from "../../i18n/context.js";
import { cn } from "../../lib/cn.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { useBootstrapStore, fetchPersonasAction } from "../../stores/api-actions/bootstrap-actions.js";
import { useProviderProfiles } from "../../hooks/use-provider-profiles.js";
import { useCharacterController } from "../../hooks/use-character-controller.js";
import { ProviderForm } from "../settings/provider/ProviderForm.js";
import { ProviderModelSelector } from "../settings/provider/ProviderModelSelector.js";
import type { FormState } from "../modals/ProviderModal.js";
import { PROVIDER_PRESETS } from "../../provider-presets.js";
import { StFolderImport } from "../modals/ImportModals.js";
import { Icons, Ic } from "../shared/icons.js";
import { Modal } from "../shared/Modal.js";
import { AvatarCropModal } from "../shared/AvatarCropModal.js";
import type { AvatarCropResult } from "../shared/AvatarCropModal.js";
import { updatePersona, createPersona, uploadAsset } from "../../app-client.js";
import { toast } from "sonner";
import { extractPngMetadata, parseCharacterMetadata } from "../../lib/png-reader.js";

type WizardPath = "choose" | "a" | "b" | "skip";
type PathAStep = 1 | 2 | 3;
type PathBStep = 0 | 1;

// ── Path selector ──
function PathSelector({ onSelect }: { onSelect: (path: WizardPath) => void }) {
  const { t } = useT();
  const isMobile = useIsMobile();

  const cardBase = "flex flex-col items-center gap-1.5 rounded-[10px] border border-border2 bg-s2 px-4 py-5 text-center text-t1 transition-all hover:border-accent hover:bg-surface cursor-pointer";

  return (
    <div className={cn("flex flex-col gap-3", isMobile ? "px-4 pb-5" : "px-7 pb-7")}>
      <button type="button" className={cardBase} onClick={() => onSelect("a")}>
        <div className="text-[1.4rem] text-accent"><Icons.Edit /></div>
        <div className="font-ui text-[0.95rem] font-semibold">{t("wizard_path_a_title")}</div>
        <div className="font-ui text-[0.8rem] text-t2">{t("wizard_path_a_sub")}</div>
      </button>
      <button type="button" className={cardBase} onClick={() => onSelect("b")}>
        <div className="text-[1.4rem] text-accent"><Icons.Import /></div>
        <div className="font-ui text-[0.95rem] font-semibold">{t("wizard_path_b_title")}</div>
        <div className="font-ui text-[0.8rem] text-t2">{t("wizard_path_b_sub")}</div>
      </button>
      <button type="button" className="mt-2 text-t3 hover:text-t2 transition-colors font-ui text-[0.85rem] underline underline-offset-2 hover:underline-offset-4" onClick={() => onSelect("skip")}>
        {t("wizard_skip_all")}
      </button>
    </div>
  );
}

// ── Step indicator for Path A ──
function StepIndicator({ step, total }: { step: number; total: number }) {
  return (
    <div className="flex items-center justify-center gap-2">
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className={cn(
            "h-1.5 rounded-full transition-all",
            i + 1 === step ? "w-6 bg-accent" : i + 1 < step ? "w-3 bg-accent/50" : "w-3 bg-s3",
          )}
        />
      ))}
    </div>
  );
}

// ── Path A, Step 1: Provider setup ──
function ProviderStep({
  onComplete,
  onSkip,
}: {
  onComplete: () => void;
  onSkip: () => void;
}) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const provider = useProviderProfiles();

  // Detect already-existing profile (e.g. created in a previous wizard run or from settings)
  const existingProfile = provider.providerProfiles[0] ?? null;
  const alreadyHasProfile = !!existingProfile;

  const [form, setForm] = useState<FormState>(() => ({
    id: existingProfile?.id ?? "",
    name: existingProfile?.name ?? "Default",
    providerPreset: existingProfile?.providerPreset ?? "",
    baseUrl: existingProfile?.endpoint ?? "",
    apiKey: "",
    hasStoredApiKey: !!existingProfile,
    model: existingProfile?.defaultModel ?? "",
    temperature: existingProfile?.temperature ?? 0.7,
    topP: existingProfile?.topP ?? 1,
    minP: existingProfile?.minP ?? 0,
    topK: existingProfile?.topK ?? 0,
    topA: existingProfile?.topA ?? 0,
    typicalP: existingProfile?.typicalP ?? 1,
    tfsZ: existingProfile?.tfsZ ?? 1,
    repeatLastN: existingProfile?.repeatLastN ?? 0,
    mirostat: existingProfile?.mirostat ?? 0,
    mirostatTau: existingProfile?.mirostatTau ?? 5,
    mirostatEta: existingProfile?.mirostatEta ?? 0.1,
    dryMultiplier: existingProfile?.dryMultiplier ?? 0,
    dryBase: existingProfile?.dryBase ?? 1.75,
    dryAllowedLength: existingProfile?.dryAllowedLength ?? 2,
    drySequenceBreakers: existingProfile?.drySequenceBreakers ?? [],
    xtcThreshold: existingProfile?.xtcThreshold ?? 0.1,
    xtcProbability: existingProfile?.xtcProbability ?? 0,
    frequencyPenalty: existingProfile?.frequencyPenalty ?? 0,
    presencePenalty: existingProfile?.presencePenalty ?? 0,
    repetitionPenalty: existingProfile?.repetitionPenalty ?? 1,
    maxTokens: existingProfile?.maxTokens ?? 512,
    contextBudget: existingProfile?.contextBudget ?? 16000,
    pinContextBudget: existingProfile?.pinContextBudget ?? false,
    stopSequences: existingProfile?.stopSequences ?? [],
    logitBias: existingProfile?.logitBias ?? [],
    seed: existingProfile?.seed ?? null,
    reasoningEffort: existingProfile?.reasoningEffort ?? "",
    showReasoning: existingProfile?.showReasoning ?? false,
    streamResponse: existingProfile?.streamResponse ?? true,
    customSamplers: existingProfile?.customSamplers ?? false,
  }));

  const [testOk, setTestOk] = useState<boolean | null>(alreadyHasProfile ? true : null);
  const [testing, setTesting] = useState(false);
  const [testingChat, setTestingChat] = useState(false);
  const [chatResult, setChatResult] = useState<{ reply?: string; error?: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [models, setModels] = useState<Array<{ id: string; label: string; contextLength?: number }>>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [modelListOpen, setModelListOpen] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // If profile already exists → collapsed view by default
  const [collapsed, setCollapsed] = useState(alreadyHasProfile);

  const updateForm = useCallback(<K extends keyof FormState>(k: K, v: FormState[K]) => {
    setForm((prev) => ({ ...prev, [k]: v }));
  }, []);

  const applyPreset = useCallback((presetId: string) => {
    const preset = PROVIDER_PRESETS.find((f) => f.id === presetId);
    if (!preset) return;
    setForm((prev) => ({ ...prev, providerPreset: presetId, baseUrl: preset.baseUrl }));
  }, []);

  async function fetchModelsFor(endpoint: string, apiKey: string, presetType?: string) {
    setFetchingModels(true);
    try {
      const fetched = await provider.handleFetchModelsByEndpoint(endpoint, apiKey.trim() || undefined, false, presetType);
      setModels(fetched);
      if (fetched.length && !form.model) updateForm("model", fetched[0].id);
      return fetched;
    } catch { return []; } finally { setFetchingModels(false); }
  }

  // Auto-fetch models when we detect an existing profile on mount
  useEffect(() => {
    if (alreadyHasProfile && existingProfile) {
      const preset = PROVIDER_PRESETS.find((f) => f.id === existingProfile.providerPreset);
      void fetchModelsFor(existingProfile.endpoint, "", preset?.type);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleTest() {
    setTesting(true);
    setTestOk(null);
    try {
      if (!form.baseUrl) return;
      const probe = await provider.handleTestDraftConnection(form.baseUrl, form.apiKey);
      setTestOk(probe.success);
      if (probe.success) {
        const preset = PROVIDER_PRESETS.find((f) => f.id === form.providerPreset);
        await fetchModelsFor(form.baseUrl, form.apiKey, preset?.type);
      }
    } catch { setTestOk(false); }
    finally { setTesting(false); }
  }

  async function handleTestChat() {
    setTestingChat(true);
    setChatResult(null);
    try {
      const pid = existingProfile?.id ?? form.id;
      if (pid) {
        const result = await provider.handleTestChat(pid, "", "", form.model.trim());
        setChatResult(result);
      } else {
        const preset = PROVIDER_PRESETS.find((f) => f.id === form.providerPreset);
        const result = await provider.handleTestChat(null, form.baseUrl.trim(), form.apiKey.trim(), form.model.trim(), preset?.type);
        setChatResult(result);
      }
    } catch (e) {
      setChatResult({ error: e instanceof Error ? e.message : "Failed" });
    } finally { setTestingChat(false); }
  }

  async function handleSave() {
    setSaving(true);
    try {
      const saved = await provider.handleSaveProviderProfileFromForm(form);
      if (saved) {
        setForm((prev) => ({ ...prev, id: saved.id, hasStoredApiKey: true }));
        toast.success(t("provider_saved"));
        // Collapse & go to next step immediately
        setCollapsed(true);
        onComplete();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("save_failed"));
    } finally {
      setSaving(false);
    }
  }

  const filteredModels = modelSearch.trim()
    ? models.filter((m) => m.label.toLowerCase().includes(modelSearch.toLowerCase()) || m.id.toLowerCase().includes(modelSearch.toLowerCase()))
    : models;

  const presetLabel = PROVIDER_PRESETS.find((f) => f.id === form.providerPreset)?.label ?? form.providerPreset;

  // ── Collapsed view (saved profile card + test + models) ──
  if (collapsed) {
    return (
      <div className={cn("flex flex-1 flex-col gap-4 overflow-y-auto", isMobile ? "px-4 pb-4" : "px-7 pb-7")}>
        <div className="flex flex-col items-stretch gap-3 rounded-lg border border-border2 bg-s2 p-3 sm:flex-row sm:items-start sm:justify-between sm:p-4">
          <div className="min-w-0">
            <div className="mb-1 truncate font-ui text-[16px] font-semibold text-t1">{form.name}</div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-ui text-[13px] text-t3 sm:flex-nowrap">
              {presetLabel && <span>{presetLabel}</span>}
              {presetLabel && <span className="h-1 w-1 rounded-full bg-t4" />}
              <span className="flex items-center gap-1.5 text-success">
                <Icons.Check />
                {t("api_key_saved")}
              </span>
            </div>
            <button type="button" className="mt-3 flex items-center gap-1.5 font-ui text-[12px] font-medium text-t2 transition-colors hover:text-accent" onClick={() => { setShowEdit(true); setCollapsed(false); }}>
              <span className="text-[11px]"><Icons.Edit /></span>
              {t("wizard_edit_provider")}
            </button>
          </div>
          <button type="button" className="min-h-11 w-full rounded-md border border-accent bg-accent-dim px-4 font-ui text-[13px] font-medium text-accent-t transition-colors hover:bg-accent hover:text-white disabled:cursor-not-allowed disabled:opacity-50 sm:h-[34px] sm:min-h-0 sm:w-auto" disabled>
            ✓ {t("provider_active")}
          </button>
        </div>

        {/* Test hi */}
        <div className="my-2 rounded-lg border border-border bg-surface p-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:gap-3">
            <button type="button"
              className="min-h-11 rounded-md border border-border bg-s2 px-4 py-2 font-ui text-[13px] font-medium text-t2 transition-colors hover:border-border2 hover:text-t1 disabled:opacity-50 sm:min-h-0 sm:py-1.5"
              onClick={() => void handleTestChat()}
              disabled={testingChat}
            >
              {testingChat ? t("sending") : t("test_hi_btn")}
            </button>
          </div>
          {chatResult && (
            <div className={cn("mt-3 rounded-md p-3 font-ui text-[12px] leading-relaxed", chatResult.error ? "bg-danger-dim text-danger-text" : "bg-s2 text-t2")}>
              {chatResult.error ?? chatResult.reply}
            </div>
          )}
        </div>

        {models.length > 0 && (
          <ProviderModelSelector
            form={form}
            models={models}
            filteredModels={filteredModels}
            fetching={fetchingModels}
            fetchError={null}
            modelSearch={modelSearch}
            modelListOpen={modelListOpen}
            favoriteModels={[]}
            updateForm={updateForm}
            onFetchModels={handleTest}
            setModelSearch={setModelSearch}
            setModelListOpen={setModelListOpen}
            dropdownRef={dropdownRef}
            onToggleFavoriteModel={async () => {}}
            requiresAuthForModels={true}
          />
        )}

        <div className="flex items-center justify-end pt-2">
          <button
            type="button"
            className="cursor-pointer rounded-lg border-0 bg-accent px-[22px] py-2.5 font-ui text-[0.9rem] font-semibold text-white transition-all"
            onClick={onComplete}
          >
            {t("next")}
          </button>
        </div>
      </div>
    );
  }

  // ── Edit / create mode (full form) ──
  const canContinue = testOk === true && form.model;

  return (
    <div className={cn("flex flex-1 flex-col gap-3 overflow-y-auto", isMobile ? "px-4 pb-4" : "px-7 pb-6")}>
      <ProviderForm
        form={form}
        editingId={form.id || null}
        providerProfiles={provider.providerProfiles}
        updateForm={updateForm}
        applyPreset={applyPreset}
        testOk={testOk}
        testing={testing}
        testingChat={testingChat}
        chatResult={chatResult}
        onTest={handleTest}
        onTestChat={handleTestChat}
        hideConnectionFields={testOk === true}
      />
      {testOk === true && (
        <div className="flex items-center gap-3 rounded-lg border border-success/20 bg-success/5 px-3 py-2">
          <span className="inline-flex items-center gap-1.5 font-ui text-[12px] text-success">
            <Icons.Check />
            {t("connection_successful")}
          </span>
          <button type="button" className="ml-auto font-ui text-[11px] font-medium text-t3 transition-colors hover:text-accent" onClick={() => { setTestOk(null); }}>
            {t("wizard_edit_provider")}
          </button>
        </div>
      )}
      {!testOk && form.apiKey && form.baseUrl && (
        <button
          type="button"
          className={cn(
            "h-[38px] cursor-pointer rounded-lg border px-5 font-ui text-[0.88rem] font-semibold transition-all",
            testing
              ? "cursor-default border-border bg-s2 text-t3"
              : "border-border bg-s2 text-t2 hover:border-accent hover:text-t1",
          )}
          disabled={testing}
          onClick={() => void handleTest()}
        >
          {testing ? t("testing") : t("test_connection")}
        </button>
      )}
      {testOk && (
        <ProviderModelSelector
          form={form}
          models={models}
          filteredModels={filteredModels}
          fetching={fetchingModels}
          fetchError={null}
          modelSearch={modelSearch}
          modelListOpen={modelListOpen}
          favoriteModels={[]}
          updateForm={updateForm}
          onFetchModels={handleTest}
          setModelSearch={setModelSearch}
          setModelListOpen={setModelListOpen}
          dropdownRef={dropdownRef}
          onToggleFavoriteModel={async () => {}}
          requiresAuthForModels={true}
        />
      )}
      <div className="flex items-center justify-between pt-2">
        <button
          type="button"
          className="cursor-pointer rounded-lg border-0 bg-transparent px-3 py-2.5 font-ui text-[0.9rem] font-semibold text-t2 transition-all hover:text-t1"
          onClick={showEdit ? () => { setCollapsed(true); setShowEdit(false); } : onSkip}
        >
          {showEdit ? t("back") : t("skip")}
        </button>
        <button
          type="button"
          className="cursor-pointer rounded-lg border-0 bg-accent px-[22px] py-2.5 font-ui text-[0.9rem] font-semibold text-white transition-all disabled:cursor-default disabled:opacity-40"
          disabled={!canContinue || saving}
          onClick={() => void handleSave()}
        >
          {saving ? t("saving") : showEdit ? t("save") : t("next")}
        </button>
      </div>
    </div>
  );
}

// ── Path A, Step 2: Persona ──
function PersonaStep({
  onComplete,
  onSkip,
  avatarPreview: avatarPreviewProp,
  avatarFile: avatarFileProp,
  onAvatarPreviewChange,
  onAvatarFileChange,
}: {
  onComplete: () => void;
  onSkip: () => void;
  avatarPreview: string | null;
  avatarFile: File | null;
  onAvatarPreviewChange: (v: string | null) => void;
  onAvatarFileChange: (v: File | null) => void;
}) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const personas = useBootstrapStore((s) => s.personas);
  const existingPersona = personas?.find((p) => p.defaultForNewChats) ?? personas?.[0];

  const [name, setName] = useState(existingPersona?.name ?? "");
  const [description, setDescription] = useState(existingPersona?.description ?? "");
  const [pronouns, setPronouns] = useState(() => {
    if (!existingPersona?.pronouns) return "";
    return ["he/him", "she/her", "they/them", "it/its"].includes(existingPersona.pronouns) ? existingPersona.pronouns : "custom";
  });
  const [pronounsCustom, setPronounsCustom] = useState(() => {
    if (!existingPersona?.pronouns) return "";
    return ["he/him", "she/her", "they/them", "it/its"].includes(existingPersona.pronouns) ? "" : (existingPersona.pronouns ?? "");
  });
  const [saving, setSaving] = useState(false);
  const avatarPreview = avatarPreviewProp;
  const croppedAvatarFile = avatarFileProp;
  const [pendingAvatar, setPendingAvatar] = useState<{ file: File; url: string } | null>(null);
  const personaAvatarRef = useRef<HTMLInputElement | null>(null);

  const PRONOUN_OPTIONS: { v: string; l: string }[] = [
    { v: "", l: t("pronouns_none") },
    { v: "he/him", l: "he/him" },
    { v: "she/her", l: "she/her" },
    { v: "they/them", l: "they/them" },
    { v: "it/its", l: "it/its" },
    { v: "custom", l: t("pronouns_custom") },
  ];

  async function handleSave() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const existing = existingPersona;
      const resolvedPronouns = pronouns === "custom" ? (pronounsCustom.trim() || null) : (pronouns || null);
      if (existing) {
        const avatarAssetId = avatarFileProp ? (await uploadAsset(avatarFileProp)).assetId : undefined;
        await updatePersona(existing.id, { name: name.trim(), description, pronouns: resolvedPronouns, avatarAssetId });
        await fetchPersonasAction();
      } else {
        const persona = await createPersona({ name: name.trim(), description, pronouns: resolvedPronouns });
        if (avatarFileProp && persona.id) {
          const asset = await uploadAsset(avatarFileProp);
          await updatePersona(persona.id, { name: name.trim(), description, pronouns: resolvedPronouns, avatarAssetId: asset.assetId });
        }
        await fetchPersonasAction();
      }
      onComplete();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("save_failed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={cn("flex flex-1 flex-col gap-3.5 overflow-y-auto", isMobile ? "px-4 pb-4" : "px-7 pb-7")}>
      <div className="font-ui text-[0.88rem] text-t2">{t("wizard_persona_hint")}</div>

      {/* Avatar */}
      <div className="flex items-center gap-4">
        <div
          className="group/ava relative flex h-16 w-16 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-full border border-dashed border-border2 bg-s2 transition-all hover:border-accent"
          onClick={() => personaAvatarRef.current?.click()}
        >
          <input
            type="file" ref={personaAvatarRef} accept="image/*" className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              e.target.value = "";
              setPendingAvatar({ file, url: URL.createObjectURL(file) });
            }}
          />
          {avatarPreview ? (
            <img src={avatarPreview} alt="" className="h-full w-full object-cover" />
          ) : (
            <span className="text-t3 transition-colors group-hover/ava:text-accent-t"><Icons.Plus /></span>
          )}
        </div>
        <div className="font-ui text-[0.8rem] text-t3">{t("wizard_avatar_hint")}</div>
      </div>
      {pendingAvatar && (
        <AvatarCropModal
          imageUrl={pendingAvatar.url}
          fileName="persona_avatar.png"
          onConfirm={(result: AvatarCropResult) => {
            onAvatarPreviewChange(URL.createObjectURL(result.croppedFile));
            onAvatarFileChange(result.croppedFile);
            setPendingAvatar(null);
          }}
          onCancel={() => {
            if (pendingAvatar.url) URL.revokeObjectURL(pendingAvatar.url);
            setPendingAvatar(null);
          }}
        />
      )}

      <label className="flex flex-col gap-1">
        <span className="font-ui text-[0.8rem] font-semibold text-t2">{t("ws_name_label")}</span>
        <input
          className={cn("w-full rounded-lg border border-border2 bg-s2 px-3 py-2.5 font-ui text-t1 outline-none transition-colors focus:border-accent", isMobile ? "text-base min-h-[44px]" : "text-[0.9rem]")}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("persona_name_placeholder")}
          autoFocus
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="font-ui text-[0.8rem] font-semibold text-t2">{t("persona_desc_placeholder")}</span>
        <textarea
          className={cn("w-full min-h-[80px] resize-y rounded-lg border border-border2 bg-s2 px-3 py-2.5 font-ui text-t1 outline-none transition-colors focus:border-accent", isMobile ? "text-base" : "text-[0.9rem]")}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t("persona_desc_placeholder")}
          rows={3}
        />
      </label>

      {/* Pronouns */}
      <div className="flex flex-col gap-1.5">
        <span className="font-ui text-[0.8rem] font-semibold text-t2">{t("pronouns_custom_placeholder")}</span>
        <div className="flex flex-wrap gap-1.5">
          {PRONOUN_OPTIONS.map((opt) => (
            <button key={opt.v} type="button"
              className={cn(
                "rounded-md px-2.5 py-1 font-ui text-[calc(var(--ui-fs)-2px)] transition-all",
                pronouns === opt.v
                  ? "bg-accent/20 text-accent-t ring-1 ring-accent/40"
                  : "bg-s3 text-t3 ring-1 ring-transparent hover:text-t2",
              )}
              onClick={() => setPronouns(opt.v)}
            >
              {opt.l}
            </button>
          ))}
        </div>
        {pronouns === "custom" && (
          <input
            className="w-full rounded-lg border border-border2 bg-s2 px-3 py-2 font-ui text-t1 outline-none transition-colors focus:border-accent"
            value={pronounsCustom}
            onChange={(e) => setPronounsCustom(e.target.value)}
            placeholder={t("pronouns_custom_placeholder")}
          />
        )}
      </div>

      <div className="flex items-center justify-between pt-2">
        <button
          type="button"
          className="cursor-pointer rounded-lg border-0 bg-transparent px-3 py-2.5 font-ui text-[0.9rem] font-semibold text-t2 transition-all hover:text-t1"
          onClick={onSkip}
        >
          {t("skip")}
        </button>
        <button
          type="button"
          className="cursor-pointer rounded-lg border-0 bg-accent px-[22px] py-2.5 font-ui text-[0.9rem] font-semibold text-white transition-all disabled:cursor-default disabled:opacity-40"
          disabled={!name.trim() || saving}
          onClick={() => void handleSave()}
        >
          {saving ? t("saving") : t("next")}
        </button>
      </div>
    </div>
  );
}

interface WizardCharacterPreview {
  file: File;
  name: string;
  description: string;
  tags: string[];
  avatarUrl: string | null;
}

function normalizeWizardCharacterPreview(raw: unknown, file: File): Omit<WizardCharacterPreview, "file" | "avatarUrl"> {
  const obj = wizardAsRecord(raw);
  const data = wizardAsRecord(obj.data) ?? obj;
  const name = wizardString(data.name) || wizardString(obj.name) || wizardString(data.char_name) || wizardString(obj.char_name) || file.name.replace(/\.[^/.]+$/, "");
  const description = wizardString(data.description) || wizardString(data.personality) || wizardString(data.char_persona) || wizardString(obj.description) || "";
  const tags = wizardArrayOfStrings(data.tags) ?? wizardArrayOfStrings(obj.tags) ?? [];
  return { name, description, tags };
}

function wizardAsRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function wizardString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function wizardArrayOfStrings(value: unknown): string[] | null {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : null;
}

function wizardInitial(value: string): string {
  return value.trim().charAt(0).toUpperCase() || "?";
}

// ── Path A, Step 3: Character ──
function CharacterStep({
  onComplete,
  onSkip,
}: {
  onComplete: () => void;
  onSkip: () => void;
}) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const character = useCharacterController();
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [firstMsg, setFirstMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [parsingCard, setParsingCard] = useState(false);
  const [cardPreview, setCardPreview] = useState<WizardCharacterPreview | null>(null);
  const [charAvatarPreview, setCharAvatarPreview] = useState<string | null>(null);
  const [charAvatarPending, setCharAvatarPending] = useState<{ file: File; url: string } | null>(null);
  const [charAvatarFile, setCharAvatarFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const charAvatarRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => () => {
    if (cardPreview?.avatarUrl) URL.revokeObjectURL(cardPreview.avatarUrl);
  }, [cardPreview?.avatarUrl]);

  async function processCharacterCard(file?: File | null): Promise<void> {
    if (!file) return;
    setParsingCard(true);
    setCardPreview((current) => {
      if (current?.avatarUrl) URL.revokeObjectURL(current.avatarUrl);
      return null;
    });
    try {
      const lowerName = file.name.toLowerCase();
      const raw = lowerName.endsWith(".png") || file.type === "image/png"
        ? parseCharacterMetadata(await extractPngMetadata(file))
        : JSON.parse(await file.text());
      const data = normalizeWizardCharacterPreview(raw, file);
      setCardPreview({ ...data, file, avatarUrl: lowerName.endsWith(".png") || file.type === "image/png" ? URL.createObjectURL(file) : null });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("import_error_read_card"));
    } finally {
      setParsingCard(false);
    }
  }

  async function handleImportPreview() {
    if (!cardPreview) return;
    setBusy(true);
    try {
      await character.handleImportFiles([cardPreview.file]);
      onComplete();
    } finally {
      setBusy(false);
    }
  }

  async function handleCreate() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await character.handleCreateCharacter({
        name: name.trim(),
        description: desc.trim() || undefined,
        firstMessage: firstMsg.trim() || undefined,
      }, charAvatarFile);
      onComplete();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={cn("flex flex-1 flex-col gap-3.5 overflow-y-auto", isMobile ? "px-4 pb-4" : "px-7 pb-7")}>
      <div className="font-ui text-[0.88rem] text-t2">{t("wizard_character_hint")}</div>
      <div className="font-ui text-[0.75rem] text-t3">{t("wizard_character_simplified")}</div>

      {/* Avatar */}
      <div className="flex items-center gap-4">
        <div
          className="group/ava relative flex h-16 w-16 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-full border border-dashed border-border2 bg-s2 transition-all hover:border-accent"
          onClick={() => charAvatarRef.current?.click()}
        >
          <input
            type="file" ref={charAvatarRef} accept="image/*" className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              e.target.value = "";
              setCharAvatarPending({ file, url: URL.createObjectURL(file) });
            }}
          />
          {charAvatarPreview ? (
            <img src={charAvatarPreview} alt="" className="h-full w-full object-cover" />
          ) : (
            <span className="text-t3 transition-colors group-hover/ava:text-accent-t"><Icons.Plus /></span>
          )}
        </div>
        <div className="font-ui text-[0.8rem] text-t3">{t("wizard_avatar_hint")}</div>
      </div>
      {charAvatarPending && (
        <AvatarCropModal
          imageUrl={charAvatarPending.url}
          fileName="character_avatar.png"
          onConfirm={(result: AvatarCropResult) => {
            setCharAvatarPreview(URL.createObjectURL(result.croppedFile));
            setCharAvatarFile(result.croppedFile);
            setCharAvatarPending(null);
          }}
          onCancel={() => {
            if (charAvatarPending.url) URL.revokeObjectURL(charAvatarPending.url);
            setCharAvatarPending(null);
          }}
        />
      )}

      <label className="flex flex-col gap-1">
        <span className="font-ui text-[0.8rem] font-semibold text-t2">{t("ws_name_label")}</span>
        <input
          className={cn("w-full rounded-lg border border-border2 bg-s2 px-3 py-2.5 font-ui text-t1 outline-none transition-colors focus:border-accent", isMobile ? "text-base min-h-[44px]" : "text-[0.9rem]")}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("ws_name_placeholder")}
          autoFocus
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="font-ui text-[0.8rem] font-semibold text-t2">{t("ws_desc_label")}</span>
        <textarea
          className={cn("w-full min-h-[60px] resize-y rounded-lg border border-border2 bg-s2 px-3 py-2.5 font-ui text-t1 outline-none transition-colors focus:border-accent", isMobile ? "text-base" : "text-[0.9rem]")}
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder={t("ws_desc_label")}
          rows={3}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="font-ui text-[0.8rem] font-semibold text-t2">{t("ws_first_msg_label")}</span>
        <textarea
          className={cn("w-full min-h-[60px] resize-y rounded-lg border border-border2 bg-s2 px-3 py-2.5 font-ui text-t1 outline-none transition-colors focus:border-accent", isMobile ? "text-base" : "text-[0.9rem]")}
          value={firstMsg}
          onChange={(e) => setFirstMsg(e.target.value)}
          placeholder={t("ws_first_msg_label")}
          rows={3}
        />
      </label>

      {/* Import card */}
      <button
        type="button"
        className="flex items-center gap-2 rounded-lg border border-dashed border-border2 bg-transparent px-4 py-3 font-ui text-[0.85rem] text-t3 transition-all hover:border-accent hover:text-accent disabled:opacity-50"
        disabled={parsingCard || busy}
        onClick={() => fileRef.current?.click()}
      >
        <Icons.Import /> {cardPreview ? t("ws_import") : t("ws_import")}
      </button>
      <input
        ref={fileRef}
        type="file"
        accept=".png,.json,image/png,application/json"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.currentTarget.value = "";
          void processCharacterCard(file);
        }}
      />

      {parsingCard && (
        <div className="rounded-lg border border-border bg-s2 px-4 py-3 font-ui text-[0.85rem] text-t2">
          {t("analyzing_metadata")}
        </div>
      )}

      {cardPreview && !parsingCard && (
        <div>
          <div className="flex gap-4 rounded-lg border border-border bg-s2 p-4">
            {cardPreview.avatarUrl ? (
              <img src={cardPreview.avatarUrl} className="h-16 w-16 shrink-0 rounded-lg bg-s3 object-cover object-top" alt="" />
            ) : (
              <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg bg-s3 font-body text-2xl italic text-t3">{wizardInitial(cardPreview.name)}</div>
            )}
            <div className="min-w-0 flex-1 font-ui">
              <div className="mb-1 text-base font-medium text-t1">{cardPreview.name}</div>
              <div className="line-clamp-3 mb-2.5 text-xs leading-relaxed text-t3">{cardPreview.description || t("no_description")}</div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {cardPreview.tags.slice(0, 6).map((tag) => <span key={tag} className="rounded bg-s3 px-2.5 py-1 font-ui text-[calc(var(--ui-fs)-3px)] text-t2">{tag}</span>)}
              </div>
            </div>
          </div>
          <div className="mt-3 font-ui text-xs text-t3">{t("ready_to_import").replace("{name}", cardPreview.file.name)}</div>
        </div>
      )}

      <div className="flex items-center justify-between pt-2">
        <button
          type="button"
          className="cursor-pointer rounded-lg border-0 bg-transparent px-3 py-2.5 font-ui text-[0.9rem] font-semibold text-t2 transition-all hover:text-t1"
          onClick={onSkip}
        >
          {t("skip")}
        </button>
        <button
          type="button"
          className="cursor-pointer rounded-lg border-0 bg-accent px-[22px] py-2.5 font-ui text-[0.9rem] font-semibold text-white transition-all disabled:cursor-default disabled:opacity-40"
          disabled={cardPreview ? busy : (!name.trim() || busy)}
          onClick={() => cardPreview ? void handleImportPreview() : void handleCreate()}
        >
          {busy ? (cardPreview ? t("importing") : t("ws_creating")) : (cardPreview ? t("add_to_library") : t("ws_create_btn"))}
        </button>
      </div>
    </div>
  );
}

// ── Path B: ST migration ──
function StMigrationStep({ onImported }: { onImported: () => void }) {
  const { t } = useT();
  const isMobile = useIsMobile();

  return (
    <div className={cn("flex flex-1 flex-col gap-4 overflow-y-auto", isMobile ? "px-4 pb-4" : "px-7 pb-7")}>
      <div className="font-ui text-[0.88rem] text-t2">{t("wizard_st_hint")}</div>
      <StFolderImport onImported={onImported} />
    </div>
  );
}

// ── Main wizard ──
export function SetupWizard({ onVisibilityChange }: { onVisibilityChange?: (v: boolean) => void }) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const bootstrapData = useBootstrapStore((s) => s.data);
  const bootstrapFirstRun = (bootstrapData?.isFirstRun ?? false) || import.meta.env.VITE_FORCE_FIRST_RUN === "true";
  const [dismissed, setDismissed] = useState(false);
  const isFirstRun = bootstrapFirstRun && !dismissed;

  useEffect(() => { onVisibilityChange?.(isFirstRun); }, [isFirstRun, onVisibilityChange]);

  const [path, setPath] = useState<WizardPath>("choose");
  const [stepA, setStepA] = useState<PathAStep>(1);
  const [stepB, setStepB] = useState<PathBStep>(0);

  // Persisted avatar state for PersonaStep (survives back navigation)
  const [personaAvatarPreview, setPersonaAvatarPreview] = useState<string | null>(null);
  const [personaAvatarFile, setPersonaAvatarFile] = useState<File | null>(null);

  if (!isFirstRun) return null;

  function handleComplete() {
    setDismissed(true);
  }

  const title = path === "choose"
    ? t("ws_title")
    : path === "a"
      ? stepA === 1 ? t("wizard_step_provider")
        : stepA === 2 ? t("wizard_step_persona")
        : t("wizard_step_character")
      : stepB === 0 ? t("wizard_step_provider")
      : t("wizard_path_b_title");

  const sub = path === "choose" ? t("ws_sub") : undefined;

  const header = (
    <div className={cn("relative shrink-0 text-center", isMobile ? "px-4 pt-5" : "px-7 pt-6")}>
      <div className="mb-1.5 font-ui text-[1.35rem] font-bold text-t1">{title}</div>
      {sub && <div className="mb-5 font-ui text-[0.88rem] text-t2">{sub}</div>}
      {path === "a" && <div className="mb-3"><StepIndicator step={stepA} total={3} /></div>}
      {path !== "choose" && (
        <button
          type="button"
          className="absolute left-4 top-5 flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-t3 transition-all hover:bg-s2 hover:text-t1"
          onClick={() => {
            if (path === "a" && stepA > 1) setStepA((s) => (s - 1) as PathAStep);
            else if (path === "b" && stepB > 0) setStepB((s) => (s - 1) as PathBStep);
            else setPath("choose");
          }}
        >
          <span className="text-[13px]">{Ic.caret('l')}</span>
        </button>
      )}
    </div>
  );

  const content = path === "choose" ? (
    <PathSelector onSelect={(p) => { if (p === "skip") handleComplete(); else setPath(p); }} />
  ) : path === "b" && stepB === 0 ? (
    <ProviderStep
      onComplete={() => setStepB(1)}
      onSkip={() => setStepB(1)}
    />
  ) : path === "b" && stepB === 1 ? (
    <StMigrationStep onImported={handleComplete} />
  ) : path === "a" ? (
    stepA === 1 ? (
      <ProviderStep
        onComplete={() => setStepA(2)}
        onSkip={() => setStepA(2)}
      />
    ) : stepA === 2 ? (
      <PersonaStep
        onComplete={() => setStepA(3)}
        onSkip={() => setStepA(3)}
        avatarPreview={personaAvatarPreview}
        avatarFile={personaAvatarFile}
        onAvatarPreviewChange={setPersonaAvatarPreview}
        onAvatarFileChange={setPersonaAvatarFile}
      />
    ) : (
      <CharacterStep
        onComplete={handleComplete}
        onSkip={handleComplete}
      />
    )
  ) : (
    <StMigrationStep onImported={() => { setPath("a"); setStepA(1); }} />
  );

  if (isMobile) {
    return (
      <div className="fixed inset-0 z-[500] flex flex-col bg-surface">
        {header}
        {content}
      </div>
    );
  }

  return (
    <Modal open={true} onClose={handleComplete}>
      <div className={cn("flex max-h-[calc(100vh-40px)] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-xl border border-border2 bg-surface shadow-theme-lg", path === "choose" ? "min-w-[360px] w-auto" : "w-[600px]")}>
        {header}
        {content}
      </div>
    </Modal>
  );
}
