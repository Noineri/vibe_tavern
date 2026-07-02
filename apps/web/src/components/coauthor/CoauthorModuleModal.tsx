import { useEffect, useState } from "react";
import { MasterDetailModal } from "../shared/MasterDetailModal.js";
import { Icons } from "../shared/icons.js";
import { useModalStore } from "../../stores/modal-store.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { listCoauthorModulesAction, setCoauthorModuleAction } from "../../stores/api-actions/chat-actions.js";
import { useT } from "../../i18n/context.js";
import { toast } from "sonner";
import { cn } from "../../lib/cn.js";
import type { CoauthorModule, CoauthorToolSet } from "@vibe-tavern/api-contracts";

/**
 * Tool labels keyed by CoauthorToolSet field. Rendered as badges in the detail
 * preview so the user can see at a glance which edits a module is allowed to
 * propose. Order is fixed for a stable layout.
 */
const TOOL_LABELS: Array<{ key: keyof CoauthorToolSet; label: string }> = [
  { key: "edit_profile", label: "edit_profile" },
  { key: "edit_section", label: "edit_section" },
  { key: "edit_greeting", label: "edit_greeting" },
  { key: "add_alt_greeting", label: "add_alt_greeting" },
  { key: "edit_alt_greeting", label: "edit_alt_greeting" },
];

/**
 * CS-16: read-only author-module picker. The modules are bundled seed presets
 * (defined in the backend registry, CS-9) — the modal cannot create or edit
 * them, only choose which one drives the co-author's base prompt, skill set,
 * tool-set filter, and step budget for THIS chat. The choice persists on the
 * chat row (`coauthor_module_id`, CS-10) and is read by prompt assembly (CS-11).
 *
 * Follows the PromptManagerModal / PersonaModal shape: rendered unconditionally
 * in AppShell, reads `isOpen` from the modal store itself, and uses the shared
 * MasterDetailModal so mobile gets the list→detail drill-down for free (parity
 * with every other config modal). Module data is loaded on open via
 * `listCoauthorModulesAction` (the RPC client landed in CS-12/CS-15); the active
 * module id is read straight off `activeChat.coauthorModuleId`, which the shared
 * `Chat` type surfaces without an extra mapping.
 *
 * `coauthorModuleId === null` means "autodetect/fallback" — the backend registry
 * resolves that to the `default` module. We mirror that resolution here so the
 * active row is highlighted even before the user picks anything.
 */
export function CoauthorModuleModal() {
  const { t } = useT();
  const isOpen = useModalStore((s) => s.isCoauthorModuleModalOpen);
  const setIsOpen = useModalStore((s) => s.setCoauthorModuleModalOpen);

  const chatId = useSnapshotStore((s) => s.activeChat?.id ?? null);
  const rawActiveModuleId = useSnapshotStore((s) => s.activeChat?.coauthorModuleId ?? null);
  // Mirror the backend registry's null→default fallback so the active row is
  // highlighted even when no module has been explicitly chosen yet.
  const activeModuleId = rawActiveModuleId ?? "default";

  const [modules, setModules] = useState<CoauthorModule[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Load the bundled module list every time the modal opens. The registry is
  // static seed data, so this is cheap; reloading on open keeps the list fresh
  // after a server update without holding it in memory while closed.
  const loadModules = async () => {
    setIsLoading(true);
    try {
      const list = await listCoauthorModulesAction();
      setModules(list);
      // Default the preview to the active module (not the first list entry) so
      // opening the modal immediately shows what is currently in effect.
      setSelectedId((prev) => prev ?? activeModuleId);
    } catch {
      // Network/parse failure is non-fatal — the modal renders its empty state.
      setModules([]);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen && modules.length === 0 && !isLoading) {
      void loadModules();
    }
  }, [isOpen]); // loadModules is stable; re-run only on the open edge

  const selected = modules.find((m) => m.id === selectedId) ?? null;
  const isSelectedActive = selected !== null && selected.id === activeModuleId;

  const handleActivate = async () => {
    if (!chatId || !selected || isSelectedActive) return;
    try {
      await setCoauthorModuleAction(chatId, selected.id);
      setIsOpen(false);
    } catch {
      toast.error(t("coauthor.module.switch_failed"));
    }
  };

  const close = () => setIsOpen(false);

  return (
    <MasterDetailModal
      isOpen={isOpen}
      onClose={close}
      title={t("coauthor.module.title")}
      subtitle={t("coauthor.module.subtitle")}
      masterContent={
        isLoading ? (
          <div className="p-4 font-ui text-[13px] text-t3">{t("coauthor.module.loading")}</div>
        ) : modules.length === 0 ? (
          <div className="p-4 font-ui text-[13px] text-t3">{t("coauthor.module.empty")}</div>
        ) : (
          <ul className="flex flex-col py-1">
            {modules.map((m) => {
              const isActive = m.id === activeModuleId;
              const isSelected = m.id === selectedId;
              return (
                <li key={m.id}>
                  <button
                    type="button"
                    className={cn(
                      "flex w-full cursor-pointer flex-col gap-0.5 border-l-2 px-3 py-2.5 text-left transition-colors",
                      isSelected ? "bg-s2" : "hover:bg-s2",
                      isActive ? "border-accent" : "border-transparent",
                    )}
                    onClick={() => setSelectedId(m.id)}
                  >
                    <span className="flex items-center gap-1.5 font-ui text-[13px] font-medium text-t1">
                      {m.name}
                      {isActive && (
                        <span className="inline-flex h-3.5 w-3.5 items-center justify-center text-accent">
                          <Icons.Check />
                        </span>
                      )}
                    </span>
                    <span className="line-clamp-2 font-ui text-[11px] text-t3">{m.description}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )
      }
      detailContent={
        selected ? (
          <ModulePreview module={selected} t={t} />
        ) : (
          <div className="font-ui text-[13px] text-t3">{t("coauthor.module.empty")}</div>
        )
      }
      footer={
        selected && !isSelectedActive ? (
          <div className="flex shrink-0 justify-end gap-2 border-t border-border bg-surface px-6 py-3">
            <button
              type="button"
              className="cursor-pointer rounded-md bg-accent px-4 py-1.5 font-ui text-[0.8rem] font-semibold text-on-accent transition-all hover:brightness-110 active:scale-[0.98]"
              onClick={() => { void handleActivate(); }}
            >
              {t("coauthor.module.activate")}
            </button>
          </div>
        ) : null
      }
    />
  );
}

interface ModulePreviewProps {
  module: CoauthorModule;
  t: (key: string) => string;
}

function ModulePreview({ module, t }: ModulePreviewProps) {
  const enabledTools = TOOL_LABELS.filter(({ key }) => module.toolSet[key] === true);
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h3 className="font-body text-[17px] font-semibold text-t1">{module.name}</h3>
        <p className="mt-1 font-ui text-[13px] leading-relaxed text-t2">{module.description}</p>
      </div>

      <dl className="flex flex-col gap-3">
        <PreviewRow label={t("coauthor.module.base_prompt")}>
          <code className="rounded bg-s2 px-1.5 py-0.5 font-mono text-[11px] text-t2">{module.basePromptFile}</code>
        </PreviewRow>

        <PreviewRow label={t("coauthor.module.max_steps")}>
          <span className="font-mono text-[13px] text-t1">{module.maxSteps}</span>
        </PreviewRow>

        <PreviewRow label={t("coauthor.module.skills")}>
          {module.skillIds.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {module.skillIds.map((id) => (
                <span key={id} className="rounded-full border border-border bg-s1 px-2 py-0.5 font-mono text-[11px] text-t2">
                  {id}
                </span>
              ))}
            </div>
          ) : (
            <span className="font-ui text-[12px] text-t3">{t("coauthor.module.no_skills")}</span>
          )}
        </PreviewRow>

        <PreviewRow label={t("coauthor.module.tools")}>
          {enabledTools.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {enabledTools.map(({ key, label }) => (
                <span key={key} className="rounded-full border border-border bg-s1 px-2 py-0.5 font-mono text-[11px] text-t2">
                  {label}
                </span>
              ))}
            </div>
          ) : (
            <span className="font-ui text-[12px] text-t3">{t("coauthor.module.no_skills")}</span>
          )}
        </PreviewRow>
      </dl>
    </div>
  );
}

function PreviewRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="font-ui text-[10px] font-semibold uppercase tracking-[0.06em] text-t3">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
