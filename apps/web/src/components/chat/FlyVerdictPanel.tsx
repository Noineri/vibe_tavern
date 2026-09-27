import { useState } from "react";
import { useT } from "../../i18n/context.js";
import {
  selectFlyGateProgress,
  type FlyVariantVerdict,
  useFlyTribunalStore,
} from "../../stores/fly-tribunal-store.js";
import { AnimatedDisclosure } from "../shared/AnimatedDisclosure.js";
import { Icons } from "../shared/icons.js";

/**
 * Fly Tribunal's shared verdict body (FT-10).
 *
 * `FlyWidget` supplies the desktop Popover ↔ mobile BottomSheet shells; this
 * body consumes only the FT-8 UI store. FT-11 keeps the active variant fresh
 * by evaluating it on message land, variant switches and saved edits, so the
 * latest evaluation is the active-variant projection at this seam.
 */
export function FlyVerdictPanel() {
  const { t } = useT();
  const precedentCount = useFlyTribunalStore((state) => state.precedentCount);
  const verdicts = useFlyTribunalStore((state) => state.verdicts);
  const actionNotice = useFlyTribunalStore((state) => state.actionNotice);
  const gate = selectFlyGateProgress({ precedentCount });
  const verdict = latestVerdict(verdicts);

  if (!gate.unlocked) {
    return (
      <section className="flex flex-col gap-2 px-3 py-2" data-testid="fly-verdict-cold-start">
        <p className="font-ui text-[calc(var(--ui-fs)-1px)] font-medium text-t1">
          {t("fly_tribunal_cold_start_title", { current: gate.current, gate: gate.gate })}
        </p>
        <p className="font-ui text-[calc(var(--ui-fs)-2px)] leading-relaxed text-t3">
          {t("fly_tribunal_cold_start_body", { gate: gate.gate })}
        </p>
      </section>
    );
  }

  if (verdict === undefined) {
    return (
      <section className="flex flex-col gap-2 px-3 py-2" data-testid="fly-verdict-empty">
        <p className="font-ui text-[calc(var(--ui-fs)-1px)] font-medium text-t1">{t("fly_tribunal_verdict_empty_title")}</p>
        <p className="font-ui text-[calc(var(--ui-fs)-2px)] leading-relaxed text-t3">{t("fly_tribunal_verdict_empty_body")}</p>
      </section>
    );
  }

  return <FlyVerdictEvidence verdict={verdict} actionNotice={actionNotice} />;
}

function FlyVerdictEvidence({ verdict, actionNotice }: { verdict: FlyVariantVerdict; actionNotice: "hint" | "auto" | "sleep" | null }) {
  const { t } = useT();
  const [openSpan, setOpenSpan] = useState<number | null>(null);
  const signal = verdict.confidence.toFixed(2);

  return (
    <section className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto px-3 py-2" data-testid="fly-verdict-evidence">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="font-ui text-[calc(var(--ui-fs)-1px)] font-medium text-t1">{t("fly_tribunal_verdict_title")}</p>
        <span className="font-ui text-[calc(var(--ui-fs)-3px)] text-t3" data-testid="fly-verdict-signal">
          {t("fly_tribunal_verdict_signal", { value: signal })}
        </span>
      </div>
      <p className="font-ui text-[calc(var(--ui-fs)-2px)] leading-relaxed text-t2">{t("fly_tribunal_verdict_metaphor")}</p>
      {actionNotice !== null && (
        <p className="rounded-md border border-border bg-s2 px-2.5 py-2 font-ui text-[calc(var(--ui-fs)-2px)] text-t2" data-testid="fly-tribunal-action-cause">
          {t(actionNotice === "auto" ? "fly_tribunal_action_auto" : actionNotice === "hint" ? "fly_tribunal_action_hint" : "fly_tribunal_action_sleep")}
        </p>
      )}
      <div className="flex flex-wrap gap-x-3 gap-y-1 font-ui text-[calc(var(--ui-fs)-3px)] text-t3">
        <span>{t("fly_tribunal_evidence_type")}</span>
        <span data-testid="fly-verdict-match-count">{t("fly_tribunal_match_count", { count: verdict.drivingSpans.length })}</span>
      </div>
      <ul className="flex flex-col gap-1.5" aria-label={t("fly_tribunal_evidence_list_label")}>
        {verdict.drivingSpans.map((span, index) => {
          const expanded = openSpan === index;
          const disclosureId = `fly-channel-${verdict.messageId}-${verdict.variantIndex}-${index}`;
          return (
            <li key={`${span.ngram}-${span.channel}-${index}`} className="rounded-md border border-border bg-s2">
              <button
                type="button"
                className="flex w-full cursor-pointer items-center justify-between gap-2 px-2.5 py-2 text-left transition-colors hover:bg-s3"
                onClick={() => setOpenSpan((current) => current === index ? null : index)}
                aria-expanded={expanded}
                aria-controls={disclosureId}
              >
                <span className="min-w-0 break-words font-ui text-[calc(var(--ui-fs)-2px)] text-t1">{span.ngram}</span>
                <Icons.Caret direction={expanded ? "u" : "d"} />
              </button>
              <AnimatedDisclosure open={expanded} keepMounted>
                <div id={disclosureId} className="border-t border-border px-2.5 py-2 font-ui text-[calc(var(--ui-fs)-3px)] text-t3">
                  {t("fly_tribunal_channel_disclosure", { channel: span.channel, activation: span.activation.toFixed(2) })}
                </div>
              </AnimatedDisclosure>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function latestVerdict(verdicts: Record<string, FlyVariantVerdict>): FlyVariantVerdict | undefined {
  return Object.values(verdicts).reduce<FlyVariantVerdict | undefined>(
    (latest, candidate) => latest === undefined || candidate.evaluatedAt >= latest.evaluatedAt ? candidate : latest,
    undefined,
  );
}
