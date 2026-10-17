/**
 * The Playground's participants roster editor — the seat cards (name field,
 * role dropdown, id editor, provider/model pickers for model seats) and the
 * «add participant» button. Moved verbatim out of `ExperiencePlayground.tsx`
 * (file-size ratchet): presentational only — the roster, grants, provider
 * lists and every handler stay in the panel, which passes them as props. The
 * panel's read-only invariant holds here too: no store is imported or written.
 */
import type { Dispatch, SetStateAction } from "react";
import { EXPERIENCE_CAPABILITY, EXPERIENCE_CONTROLLER, type ExperienceCapability } from "@vibe-tavern/domain";
import { useT } from "../../../i18n/context.js";
import { lblCls } from "../../../lib/field-tokens.js";
import { DropdownSelect } from "../../shared/DropdownSelect.js";
import { Ic } from "../../shared/icons.js";
import { TextInput } from "../../shared/text-input.js";
import { seatInitial, uniqueIdFor, type PlaygroundSeat } from "./experience-playground-model.js";

const CONTROLLERS = [
  EXPERIENCE_CONTROLLER.human,
  EXPERIENCE_CONTROLLER.script,
  EXPERIENCE_CONTROLLER.model,
] as const;

/** Friendly (non-technical) role labels for the roster card dropdown. The
 *  technical controller values map 1:1 (human/model/script) — only the label
 *  changes; the domain value sent to Start is untouched. */
export const CONTROLLER_LABEL_KEY = {
  [EXPERIENCE_CONTROLLER.human]: "experience_playground_role_human",
  [EXPERIENCE_CONTROLLER.script]: "experience_playground_role_script",
  [EXPERIENCE_CONTROLLER.model]: "experience_playground_role_model",
} as const;

interface PlaygroundRosterProps {
  seats: PlaygroundSeat[];
  grants: readonly ExperienceCapability[];
  /** Which seat's id editor is currently revealed (null = none). */
  editingIdIndex: number | null;
  setEditingIdIndex: Dispatch<SetStateAction<number | null>>;
  setSeats: Dispatch<SetStateAction<PlaygroundSeat[]>>;
  setSeatsTouched: Dispatch<SetStateAction<boolean>>;
  updateSeat: (index: number, patch: Partial<PlaygroundSeat>) => void;
  updateSeatLabel: (index: number, label: string) => void;
  updateSeatId: (index: number, id: string) => void;
  providerOptions: Array<{ id: string; label: string }>;
  loadingProfiles: Set<string>;
  ensureModels: (profileId: string) => void;
  modelOptionsFor: (profileId: string) => Array<{ id: string; label: string }>;
}

export function PlaygroundRoster({
  seats,
  grants,
  editingIdIndex,
  setEditingIdIndex,
  setSeats,
  setSeatsTouched,
  updateSeat,
  updateSeatLabel,
  updateSeatId,
  providerOptions,
  loadingProfiles,
  ensureModels,
  modelOptionsFor,
}: PlaygroundRosterProps) {
  const { t } = useT();

  return (
            <div>
              <label className={lblCls}>{t("experience_setup_participants_label")}</label>
            {seats.map((seat, index) => (
              <div key={index} className="mb-2 rounded-xl border border-border bg-surface p-2.5">
                {/* Name field and controller dropdown share one height on
                    every viewport: TextInput's base is h-11 / sm:h-[38px],
                    the DropdownSelect trigger has none (py-[7px], ~35px) —
                    both pinned to the Playground's 34px field row (the seed /
                    human-seat pair, experience-playground-start-options). */}
                <div className="flex flex-wrap items-center gap-2">
                  <div
                    aria-hidden
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-dim font-ui text-sm font-semibold text-accent-t"
                  >
                    {seatInitial(seat)}
                  </div>
                  <TextInput
                    className="min-w-[7rem] flex-1 !h-[34px]"
                    value={seat.label}
                    placeholder={t("experience_setup_participant_name_placeholder")}
                    aria-label={t("experience_playground_participant_name")}
                    onChange={(e) => updateSeatLabel(index, e.target.value)}
                  />
                  <div className="w-48 shrink-0">
                    <DropdownSelect
                      value={seat.controller}
                      options={CONTROLLERS.map((controller) => ({ id: controller, label: t(CONTROLLER_LABEL_KEY[controller]) }))}
                      searchable={false}
                      className="h-[34px]"
                      onChange={(value) => {
                        const controller = CONTROLLERS.find((c) => c === value);
                        if (controller !== undefined) {
                          if (controller !== EXPERIENCE_CONTROLLER.model) {
                            updateSeat(index, { controller, providerProfileId: undefined, modelId: undefined });
                          } else {
                            updateSeat(index, { controller });
                          }
                        }
                      }}
                    />
                  </div>
                  <button
                    type="button"
                    aria-label={t("experience_setup_remove_participant")}
                    className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded text-t2 transition-all hover:bg-s3 hover:text-t1"
                    onClick={() => { setSeatsTouched(true); setSeats((prev) => prev.filter((_, i) => i !== index)); }}
                  >
                    <Ic.del />
                  </button>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-10">
                  {editingIdIndex === index ? (
                    <TextInput
                      autoFocus
                      className="w-32"
                      value={seat.id}
                      aria-label={t("experience_playground_participant_id")}
                      onChange={(e) => updateSeatId(index, e.target.value)}
                      onBlur={() => setEditingIdIndex(null)}
                      onKeyDown={(e) => { if (e.key === "Enter") setEditingIdIndex(null); }}
                    />
                  ) : (
                    <span className="font-mono text-[11px] text-t3">
                      {t("experience_playground_participant_id")}: <span className="text-t2" data-testid="playground-seat-id">{seat.id === "" ? "—" : seat.id}</span>
                    </span>
                  )}
                  <button
                    type="button"
                    aria-label={t("experience_playground_participant_id_edit")}
                    className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded text-t3 transition-all hover:bg-s3 hover:text-t1"
                    onClick={() => setEditingIdIndex(editingIdIndex === index ? null : index)}
                  >
                    <Ic.edit />
                  </button>
                </div>
                {seat.controller === EXPERIENCE_CONTROLLER.model && grants.includes(EXPERIENCE_CAPABILITY.model) && (
                  <div className="mt-1.5 flex flex-col gap-1.5 pl-10 sm:flex-row">
                    <div className="flex-1">
                      <DropdownSelect
                        value={seat.providerProfileId ?? ""}
                        options={providerOptions}
                        placeholder={t("experience_setup_provider_placeholder")}
                        onChange={(value) => {
                          updateSeat(index, { providerProfileId: value, modelId: undefined });
                          ensureModels(value);
                        }}
                      />
                    </div>
                    <div className="flex-1">
                      <DropdownSelect
                        value={seat.modelId ?? ""}
                        options={seat.providerProfileId ? modelOptionsFor(seat.providerProfileId) : []}
                        placeholder={loadingProfiles.has(seat.providerProfileId ?? "") ? t("experience_setup_loading_models") : t("experience_setup_model_placeholder")}
                        disabled={seat.providerProfileId === undefined}
                        onChange={(value) => updateSeat(index, { modelId: value })}
                      />
                    </div>
                  </div>
                )}
              </div>
            ))}
            <button
              type="button"
              className="mt-1 flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-s3 px-2.5 font-ui text-[11px] text-t2 transition-all hover:bg-s2 hover:text-t1"
              onClick={() => {
                setSeatsTouched(true);
                setSeats((prev) => {
                  const taken = new Set(prev.map((s) => s.id));
                  return [...prev, { id: uniqueIdFor("seat", taken), label: "", controller: EXPERIENCE_CONTROLLER.human, idAuto: true }];
                });
              }}
            >
              <Ic.plus /> {t("experience_setup_add_participant")}
            </button>
          </div>
  );
}
