/**
 * SetupWizard — first-run wizard with two paths:
 *   Path A: "Начать настройку" (provider → persona → character)
 *   Path B: "Переезд из SillyTavern" (ST bulk import → provider)
 */
import { useState, useCallback } from "react";
import { useT } from "../../i18n/context.js";
import { cn } from "../../lib/cn.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { useBootstrapStore } from "../../stores/api-actions/bootstrap-actions.js";
import { useProviderProfiles } from "../../hooks/use-provider-profiles.js";
import { useCharacterController } from "../../hooks/use-character-controller.js";
import { ProviderForm } from "../settings/provider/ProviderForm.js";
import type { FormState } from "../modals/ProviderModal.js";
import { PROVIDER_PRESETS } from "../../provider-presets.js";
import { StFolderImport } from "../modals/ImportModals.js";
import { Icons, Ic } from "../shared/icons.js";
import { Modal } from "../shared/Modal.js";
import { toast } from "sonner";

type WizardPath = "choose" | "a" | "b";
type PathAStep = 1 | 2 | 3;

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

  // Start with a fresh profile form
  const [form, setForm] = useState<FormState>(() => ({
    id: "",
    name: "Default",
    providerPreset: "",
    baseUrl: "",
    apiKey: "",
    hasStoredApiKey: false,
    model: "",
    temperature: 0.7,
    topP: 1,
    minP: 0,
    topK: 0,
    topA: 0,
    typicalP: 1,
    tfsZ: 1,
    repeatLastN: 0,
    mirostat: 0,
    mirostatTau: 5,
    mirostatEta: 0.1,
    dryMultiplier: 0,
    dryBase: 1.75,
    dryAllowedLength: 2,
    drySequenceBreakers: [],
    xtcThreshold: 0.1,
    xtcProbability: 0,
    frequencyPenalty: 0,
    presencePenalty: 0,
    repetitionPenalty: 1,
    maxTokens: 512,
    contextBudget: 16000,
    pinContextBudget: false,
    stopSequences: [],
    logitBias: [],
    seed: null,
    reasoningEffort: "",
    showReasoning: false,
    streamResponse: true,
    customSamplers: false,
  }));

  const [testOk, setTestOk] = useState<boolean | null>(null);
  const [testing, setTesting] = useState(false);
  const [testingChat, setTestingChat] = useState(false);
  const [chatResult, setChatResult] = useState<{ reply?: string; error?: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const updateForm = useCallback(<K extends keyof FormState>(k: K, v: FormState[K]) => {
    setForm((prev) => ({ ...prev, [k]: v }));
  }, []);

  const applyPreset = useCallback((presetId: string) => {
    const preset = PROVIDER_PRESETS.find((f) => f.id === presetId);
    if (!preset) return;
    setForm((prev) => ({
      ...prev,
      providerPreset: presetId,
      baseUrl: preset.baseUrl,
    }));
  }, []);

  async function handleTest() {
    setTesting(true);
    setTestOk(null);
    try {
      const endpoint = form.baseUrl;
      const apiKey = form.apiKey;
      if (!endpoint) return;
      const probe = await provider.handleTestDraftConnection(endpoint, apiKey);
      setTestOk(probe.success);
      if (probe.success) {
        // Models need separate fetch — for now just mark as connected
      }
    } catch {
      setTestOk(false);
    } finally {
      setTesting(false);
    }
  }

  async function handleTestChat() {
    setTestingChat(true);
    setChatResult(null);
    try {
      // Need a saved profile for chat test — skip for now in wizard
      setChatResult({ reply: undefined, error: "Save profile first" });
    } finally {
      setTestingChat(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      // Create profile via provider hook
      const saved = await provider.handleSaveProviderProfileFromForm(form);
      if (saved) {
        toast.success(t("provider_saved"));
        onComplete();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("save_failed"));
    } finally {
      setSaving(false);
    }
  }

  const canContinue = testOk === true && form.model;

  return (
    <div className={cn("flex flex-1 flex-col gap-4 overflow-y-auto", isMobile ? "px-4 pb-4" : "px-7 pb-7")}>
      <ProviderForm
        form={form}
        editingId={null}
        providerProfiles={provider.providerProfiles}
        updateForm={updateForm}
        applyPreset={applyPreset}
        testOk={testOk}
        testing={testing}
        testingChat={testingChat}
        chatResult={chatResult}
        onTest={handleTest}
        onTestChat={handleTestChat}
      />
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
          disabled={!canContinue || saving}
          onClick={() => void handleSave()}
        >
          {saving ? t("saving") : t("next")}
        </button>
      </div>
    </div>
  );
}

// ── Path A, Step 2: Persona ──
function PersonaStep({
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
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await character.handleCreatePersona({ name: name.trim(), description });
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
  const fileRef = useState<HTMLInputElement | null>(null)[0];
  const setFileRef = useState<HTMLInputElement | null>(null)[1];

  async function handleCreate() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await character.handleCreateCharacter({
        name: name.trim(),
        description: desc.trim() || undefined,
        firstMessage: firstMsg.trim() || undefined,
      });
      onComplete();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={cn("flex flex-1 flex-col gap-3.5 overflow-y-auto", isMobile ? "px-4 pb-4" : "px-7 pb-7")}>
      <div className="font-ui text-[0.88rem] text-t2">{t("wizard_character_hint")}</div>

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
        className="flex items-center gap-2 rounded-lg border border-dashed border-border2 bg-transparent px-4 py-3 font-ui text-[0.85rem] text-t3 transition-all hover:border-accent hover:text-accent"
        onClick={() => fileRef?.click()}
      >
        <Icons.Import /> {t("ws_import")}
      </button>
      <input
        ref={(el) => setFileRef(el)}
        type="file"
        accept=".png,.json"
        className="hidden"
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) {
            character.handleImportFiles(e.target.files);
            onComplete();
          }
        }}
      />

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
          disabled={!name.trim() || busy}
          onClick={() => void handleCreate()}
        >
          {busy ? t("ws_creating") : t("ws_create_btn")}
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
export function SetupWizard() {
  const { t } = useT();
  const isMobile = useIsMobile();
  const bootstrapData = useBootstrapStore((s) => s.data);
  const bootstrapFirstRun = (bootstrapData?.isFirstRun ?? false) || import.meta.env.VITE_FORCE_FIRST_RUN === "true";
  const [dismissed, setDismissed] = useState(() => localStorage.getItem("wizard_dismissed") === "1");
  const isFirstRun = bootstrapFirstRun && !dismissed;

  const [path, setPath] = useState<WizardPath>("choose");
  const [stepA, setStepA] = useState<PathAStep>(1);

  if (!isFirstRun) return null;

  function handleComplete() {
    localStorage.setItem("wizard_dismissed", "1");
    setDismissed(true);
  }

  const title = path === "choose"
    ? t("ws_title")
    : path === "a"
      ? stepA === 1 ? t("wizard_step_provider")
        : stepA === 2 ? t("wizard_step_persona")
        : t("wizard_step_character")
      : t("wizard_path_b_title");

  const sub = path === "choose" ? t("ws_sub") : undefined;

  const header = (
    <div className={cn("relative shrink-0 text-center", isMobile ? "px-4 pt-5" : "px-7 pt-7")}>
      <div className="mb-1.5 font-ui text-[1.35rem] font-bold text-t1">{title}</div>
      {sub && <div className="mb-6 font-ui text-[0.88rem] text-t2">{sub}</div>}
      {path === "a" && <div className="mb-4"><StepIndicator step={stepA} total={3} /></div>}
      {path !== "choose" && (
        <button
          type="button"
          className="absolute left-4 top-5 flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-t3 transition-all hover:bg-s2 hover:text-t1"
          onClick={() => {
            if (path === "a" && stepA > 1) setStepA((s) => (s - 1) as PathAStep);
            else setPath("choose");
          }}
        >
          <span className="text-[13px]">{Ic.caret('l')}</span>
        </button>
      )}
    </div>
  );

  const content = path === "choose" ? (
    <PathSelector onSelect={setPath} />
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
      <div className="flex max-h-[calc(100vh-40px)] max-w-[calc(100vw-32px)] w-[600px] h-[680px] flex-col overflow-hidden rounded-xl border border-border2 bg-surface shadow-theme-lg">
        {header}
        {content}
      </div>
    </Modal>
  );
}
