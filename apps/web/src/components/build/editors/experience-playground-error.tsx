/**
 * The Playground's typed error panel — the human-readable message, the copilot
 * escape hatch and the technical-details disclosure (kernel kind, current
 * revision, granted/needs, VM console). Moved verbatim out of
 * `ExperiencePlayground.tsx` (file-size ratchet): presentational only — the
 * error value, the disclosure state and the copilot callback stay in the panel.
 * The panel renders this only while an error is set.
 */
import type { Dispatch, SetStateAction } from "react";
import { useT } from "../../../i18n/context.js";
import { cn } from "../../../lib/cn.js";
import { AnimatedDisclosure } from "../../shared/AnimatedDisclosure.js";
import { Ic } from "../../shared/icons.js";
import { ConsoleBlock } from "./experience-playground-results.js";
import type { PlaygroundErrorView } from "./experience-playground-model.js";

interface PlaygroundErrorPanelProps {
  error: PlaygroundErrorView;
  errorTechOpen: boolean;
  setErrorTechOpen: Dispatch<SetStateAction<boolean>>;
  /** Present only when the shell wires the copilot; the button is hidden otherwise. */
  onAskCopilot: (() => void) | undefined;
}

export function PlaygroundErrorPanel({ error, errorTechOpen, setErrorTechOpen, onAskCopilot }: PlaygroundErrorPanelProps) {
  const { t } = useT();

  return (
    <>
          {/* Typed error (start or advance) — human first, tech under a
              disclosure, and a copilot escape hatch (XU-3). */}
            <div className="mt-3 rounded-md border border-danger bg-danger-dim" style={{ padding: 10 }}>
              <div className="flex items-start gap-2">
                <span aria-hidden className="mt-0.5 shrink-0 text-danger-text"><Ic.alert /></span>
                <p className="font-ui text-[13px] leading-snug text-danger-text">{error.message}</p>
              </div>
              {onAskCopilot !== undefined && (
                <button
                  type="button"
                  data-testid="playground-error-ask-copilot"
                  className="mt-2 flex h-8 cursor-pointer items-center gap-1.5 rounded-md border-0 bg-accent px-4 font-ui text-xs font-medium text-on-accent transition-all disabled:cursor-default disabled:opacity-40"
                  onClick={onAskCopilot}
                >
                  <Ic.sparkles />
                  {t("experience_playground_error_ask_copilot")}
                </button>
              )}
              <div className="mt-2">
                <button
                  type="button"
                  className="flex w-full cursor-pointer items-center gap-1.5 text-left"
                  onClick={() => setErrorTechOpen((v) => !v)}
                  aria-expanded={errorTechOpen}
                >
                  <span className={cn("inline-block shrink-0 text-danger-text transition-transform", errorTechOpen && "rotate-90")}>
                    {Ic.caret("r")}
                  </span>
                  <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-danger-text">{t("experience_playground_error_tech_details")}</span>
                </button>
                <AnimatedDisclosure open={errorTechOpen}>
                  <div className="mt-1.5 space-y-1.5">
                    {error.code !== undefined && (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[11px] font-semibold uppercase text-danger-text">{t("experience_playground_error_title")}</span>
                        <span className="rounded bg-danger/20 px-1.5 py-0.5 font-mono text-[10px] uppercase text-danger-text">{error.code}</span>
                      </div>
                    )}
                    <div className="space-y-0.5 font-ui text-[11px] text-t2">
                      {error.kind !== undefined && (
                        <div><span className="text-t3">{t("experience_tester_error_kind")}: </span><span className="font-mono">{error.kind}</span></div>
                      )}
                      {error.currentRevision !== undefined && (
                        <div><span className="text-t3">{t("experience_tester_error_current_revision")}: </span><span className="font-mono">{error.currentRevision}</span></div>
                      )}
                      {error.granted !== undefined && (
                        <div><span className="text-t3">{t("experience_tester_error_granted")}: </span><span className="font-mono">{error.granted.join(", ")}</span></div>
                      )}
                      {error.needs !== undefined && (
                        <div><span className="text-t3">{t("experience_tester_error_needs")}: </span><span className="font-mono">{error.needs.join(", ")}</span></div>
                      )}
                    </div>
                    <ConsoleBlock entries={error.console} label={t("script_test_console")} />
                  </div>
                </AnimatedDisclosure>
              </div>
            </div>
    </>
  );
}
