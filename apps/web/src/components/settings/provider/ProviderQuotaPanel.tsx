import { useCallback, useEffect, useRef, useState } from "react";
import {
  PROVIDER_QUOTA_KIND,
  QUOTA_POLL_INTERVAL_MINUTES_MAX,
  QUOTA_POLL_INTERVAL_MINUTES_MIN,
  type ProviderQuotaConfig,
} from "@vibe-tavern/domain";
import { useT } from "../../../i18n/context.js";
import { cn } from "../../../lib/cn.js";
import { AnimatedDisclosure } from "../../shared/AnimatedDisclosure.js";
import { Icons } from "../../shared/icons.js";
import { NumberInput } from "../../shared/NumberInput.js";
import { SegmentedControl } from "../../shared/SegmentedControl.js";
import { Toggle } from "../../shared/Toggle.js";
import { selectQuotaEntry, useQuotaStore } from "../../../stores/quota-store.js";

/**
 * Provider-quota settings — the disclosure that only exists for providers whose
 * quota can actually be read.
 *
 * The header toggle is the feature switch: turning it on is what puts the quota
 * indicator in the chat toolbar. Everything inside is opt-in detail on top of
 * that, and the notification rows exist only for `windowed` providers — a money
 * balance has no denominator, so "10% left" is not a statement that can be made
 * about it (the config type enforces this; the UI just doesn't render what it
 * cannot store).
 *
 * Writes go straight to `PUT /api/providers/:id/quota-config` rather than
 * through the modal's form autosave: quota settings live in their own table and
 * their own store, and the backend needs the write to trigger a poll resync.
 * Toggles and segment clicks commit immediately; the threshold slider debounces
 * so dragging it is one request, not eighty.
 */

const COMMIT_DEBOUNCE_MS = 400;

const POLL_INTERVAL_OPTIONS = Array.from(
  { length: QUOTA_POLL_INTERVAL_MINUTES_MAX - QUOTA_POLL_INTERVAL_MINUTES_MIN + 1 },
  (_, index) => QUOTA_POLL_INTERVAL_MINUTES_MIN + index,
);

export interface ProviderQuotaPanelProps {
  providerProfileId: string;
}

export function ProviderQuotaPanel({ providerProfileId }: ProviderQuotaPanelProps) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [draft, setDraft] = useState<ProviderQuotaConfig | null>(null);

  const entry = useQuotaStore(selectQuotaEntry(providerProfileId));
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const { fetchCapability, fetchQuota } = useQuotaStore.getState();
    void fetchCapability(providerProfileId);
    void fetchQuota(providerProfileId);
  }, [providerProfileId]);

  // The server's config is the source of truth; the draft only exists so a
  // dragged slider moves at pointer speed instead of at request speed.
  useEffect(() => {
    setDraft(entry.config);
  }, [entry.config]);

  useEffect(() => () => {
    if (commitTimer.current) clearTimeout(commitTimer.current);
  }, []);

  const commit = useCallback((next: ProviderQuotaConfig, debounce: boolean) => {
    setDraft(next);
    setSaveError(null);
    if (commitTimer.current) clearTimeout(commitTimer.current);

    const send = () => {
      commitTimer.current = null;
      void useQuotaStore.getState()
        .updateConfig(providerProfileId, next)
        .catch((error: unknown) => {
          setSaveError(error instanceof Error ? error.message : String(error));
        });
    };

    if (debounce) commitTimer.current = setTimeout(send, COMMIT_DEBOUNCE_MS);
    else send();
  }, [providerProfileId]);

  // Nothing to configure for a provider that exposes no quota, and nothing to
  // render before the capability lookup answers — an empty accordion that
  // vanishes a moment later is worse than one that appears a moment late.
  const kind = entry.capability?.kind;
  if (!kind || kind === PROVIDER_QUOTA_KIND.none) return null;
  if (!draft || draft.kind === PROVIDER_QUOTA_KIND.none) return null;

  const windowed = draft.kind === PROVIDER_QUOTA_KIND.windowed ? draft : null;

  return (
    <div className="mt-4 overflow-hidden rounded-lg border border-border2">
      <div
        className={cn(
          "flex w-full items-center justify-between bg-s2 px-3 py-3 font-ui text-[13px] font-medium text-t1 transition-colors hover:bg-[var(--border)]",
          open && "!rounded-b-none",
        )}
      >
        <button
          type="button"
          className="flex cursor-pointer items-center gap-2 font-ui text-[13px] font-medium text-t1"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
        >
          <span className={cn("transition-transform", open && "rotate-90")}>
            <Icons.Caret direction="r" />
          </span>
          {t("quota_section")}
        </button>
        <Toggle
          checked={draft.displayEnabled}
          onChange={(value) => commit({ ...draft, displayEnabled: value }, false)}
          aria-label={t("quota_display_enabled")}
        />
      </div>

      <AnimatedDisclosure open={open} className="border-t border-border2 bg-surface p-4">
        <p className="mb-3 font-ui text-[calc(var(--ui-fs)-3px)] leading-[1.5] text-t3">
          {t("quota_section_hint")}
        </p>

        {windowed && (
          <>
            <div className="mb-3 rounded-lg border border-border2 bg-s2 px-4 py-3">
              <div className="flex items-center gap-3">
                <Toggle
                  checked={windowed.lowQuotaEnabled}
                  onChange={(value) => commit({ ...windowed, lowQuotaEnabled: value }, false)}
                  aria-label={t("quota_low_notify")}
                />
                <div>
                  <div className="font-ui text-[13px] font-medium text-t1">{t("quota_low_notify")}</div>
                  <div className="mt-0.5 text-[calc(var(--ui-fs)-3px)] leading-[1.5] text-t3">
                    {t("quota_low_notify_hint")}
                  </div>
                </div>
              </div>

              <div className={cn("mt-3", !windowed.lowQuotaEnabled && "pointer-events-none opacity-40")}>
                <label className="mb-[7px] block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3">
                  {t("quota_low_threshold")}
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="range"
                    min={1}
                    max={100}
                    step={1}
                    value={windowed.lowQuotaRemainingPercent}
                    disabled={!windowed.lowQuotaEnabled}
                    aria-label={t("quota_low_threshold")}
                    onChange={(event) => {
                      const value = parseInt(event.target.value, 10);
                      if (!Number.isNaN(value)) {
                        commit({ ...windowed, lowQuotaRemainingPercent: value }, true);
                      }
                    }}
                    className="!h-[6px] !w-auto flex-1 !rounded-full !border-0 accent-accent p-0"
                  />
                  <NumberInput
                    className="h-[30px] w-[64px] shrink-0"
                    min={1}
                    max={100}
                    step={1}
                    value={windowed.lowQuotaRemainingPercent}
                    disabled={!windowed.lowQuotaEnabled}
                    onChange={(value) => commit({ ...windowed, lowQuotaRemainingPercent: value }, true)}
                    hideControls
                  />
                </div>
              </div>
            </div>

            <div className="mb-3 rounded-lg border border-border2 bg-s2 px-4 py-3">
              <div className="flex items-center gap-3">
                <Toggle
                  checked={windowed.resetNotifyEnabled}
                  onChange={(value) => commit({ ...windowed, resetNotifyEnabled: value }, false)}
                  aria-label={t("quota_reset_notify")}
                />
                <div>
                  <div className="font-ui text-[13px] font-medium text-t1">{t("quota_reset_notify")}</div>
                  <div className="mt-0.5 text-[calc(var(--ui-fs)-3px)] leading-[1.5] text-t3">
                    {t("quota_reset_notify_hint")}
                  </div>
                </div>
              </div>
            </div>
          </>
        )}

        <div>
          <label className="mb-[7px] block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3">
            {t("quota_poll_interval")}
          </label>
          <SegmentedControl
            value={String(draft.pollIntervalMinutes)}
            options={POLL_INTERVAL_OPTIONS.map((minutes) => ({
              value: String(minutes),
              label: t("quota_minutes_short", { minutes }),
            }))}
            onChange={(value) => {
              const minutes = parseInt(value, 10);
              if (!Number.isNaN(minutes)) commit({ ...draft, pollIntervalMinutes: minutes }, false);
            }}
          />
          <p className="mt-1.5 text-[calc(var(--ui-fs)-3px)] leading-[1.5] text-t3">
            {t("quota_poll_interval_hint")}
          </p>
        </div>

        {saveError && (
          <div className="mt-3 flex items-center gap-1.5 text-[12px] text-danger">
            <span className="[&_svg]:h-[12px] [&_svg]:w-[12px]"><Icons.Alert /></span>
            {saveError}
          </div>
        )}
      </AnimatedDisclosure>
    </div>
  );
}
