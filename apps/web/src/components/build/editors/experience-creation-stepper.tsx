import { useT } from "../../../i18n/context.js";
import { cn } from "../../../lib/cn.js";
import { Ic } from "../../shared/icons.js";
import type { ExperienceCopilotStep } from "./copilot/ExperienceCopilotShell.js";

/** XU-6 creation stepper extracted verbatim from ExperienceEditor to preserve
 * its size cap. The active step mirrors the shell's current position and
 * completed steps get a check. */
export function ExperienceCreationStepper({
  activeStep,
  steps,
}: {
  activeStep: ExperienceCopilotStep;
  steps: readonly ExperienceCopilotStep[];
}) {
  const { t } = useT();
  return (
    <div
      className="flex shrink-0 items-center gap-1.5 border-b border-border bg-surface px-3 py-1.5"
      data-testid="experience-creation-stepper"
    >
      {steps.map((step, index) => {
        const isActive = activeStep === step;
        const isDone = steps.indexOf(activeStep) > index;
        const label =
          step === "rules"
            ? t("agent_rules")
            : step === "appearance"
              ? t("experience_editor_step_appearance")
              : t("agent_try_it");
        return (
          <div key={step} className="flex items-center gap-1.5">
            {index > 0 && <span className="text-t4">{Ic.caret("r")}</span>}
            <span
              className={cn(
                "flex items-center gap-1.5 font-ui text-[11px] font-medium",
                isActive ? "text-accent-t" : isDone ? "text-t2" : "text-t3",
              )}
            >
              <span
                className={cn(
                  "flex h-4 w-4 items-center justify-center rounded-full text-[9px]",
                  isDone ? "bg-accent text-on-accent" : "bg-s3 text-t3",
                )}
              >
                {isDone ? Ic.check() : index + 1}
              </span>
              {label}
            </span>
          </div>
        );
      })}
    </div>
  );
}
