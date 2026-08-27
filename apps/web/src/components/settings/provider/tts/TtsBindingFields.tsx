/**
 * TTS voice-map fields (TTS_PLAN TS-9b) — rendered inside TtsProfileEditor.
 *
 * Two surfaces on one hook (`useTtsLinks`):
 *  - "Voice map": bind THIS profile to characters/personas (mode "voice").
 *  - "Muted characters": character-level disable. Renders ONLY when the
 *    profile being edited IS the default profile — mute rows are FK-bound to
 *    the default profile (a mute marker needs a profile row to live on), and
 *    with no default profile there is no narration to mute anyway (the
 *    resolver only narrates via a default or an explicit binding).
 *
 * The two surfaces MERGE on write (see use-tts-links compute* rules): the
 * bind popover preserves this profile's mute rows, the mute control
 * preserves its voice rows — a full-set PUT from either side must not wipe
 * the other.
 */

import { useT } from "../../../../i18n/context.js";
import {
  LinkBindingPopover,
  type LinkBindingRecord,
  type LinkTarget,
} from "../../../shared/LinkBindingPopover.js";
import { lblCls } from "../../../build/fields/field-styles.js";
import { useIsMobile } from "../../../../hooks/use-mobile.js";
import { useAllCharacters } from "../../../../stores/snapshot-store.js";
import { useBootstrapStore } from "../../../../stores/api-actions/bootstrap-actions.js";
import { isDefaultProfileRow, useTtsLinks } from "./use-tts-links.js";
import type { useTtsProfiles } from "./use-tts-profiles.js";

type TtsHook = ReturnType<typeof useTtsProfiles>;

/** Type guard: the popover emits the full LinkBindingTargetType union, but
 *  only character/persona targets exist in the TTS voice map — this narrows
 *  without a cast. */
function isVoiceMapTarget(
  link: LinkBindingRecord,
): link is LinkBindingRecord & { targetType: "character" | "persona" } {
  return link.targetType === "character" || link.targetType === "persona";
}

export function TtsBindingFields({ tts, form }: { tts: TtsHook; form: NonNullable<TtsHook["form"]> }) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const { links, error, setVoiceTargets, setMutedCharacters } = useTtsLinks(form.id);
  const allCharacters = useAllCharacters();
  const personas = useBootstrapStore((s) => s.personas) ?? [];

  // Canonical LinkTarget mapping (verbatim from LorebookEditor — avatar
  // resolution fields, kind, updatedAt cache-bust).
  const linkCharacters: LinkTarget[] = allCharacters.map((c) => ({
    id: c.id,
    name: c.name,
    avatarAssetId: c.avatarAssetId,
    kind: "characters",
    avatarExt: c.avatarExt,
    avatarFullExt: c.avatarFullExt,
    avatarFullAssetId: c.avatarFullAssetId,
    updatedAt: c.updatedAt,
  }));
  const linkPersonas: LinkTarget[] = personas.map((p) => ({
    id: p.id,
    name: p.name,
    avatarAssetId: p.avatarAssetId,
    kind: "personas",
    avatarExt: p.avatarExt,
    avatarFullExt: p.avatarFullExt,
    avatarFullAssetId: p.avatarFullAssetId,
    updatedAt: p.updatedAt,
  }));

  // The parent gates rendering on form.id !== null; keep the guard here too
  // (defensively — hooks stay above it, so order is stable either way).
  if (form.id === null) return null;

  const voiceLinks: LinkBindingRecord[] = links
    .filter((l) => (l.mode ?? "voice") === "voice")
    .map((l) => ({ targetType: l.targetType, targetId: l.targetId }));
  const mutedLinks: LinkBindingRecord[] = links
    .filter((l) => l.mode === "disabled" && l.targetType === "character")
    .map((l): LinkBindingRecord => ({ targetType: "character", targetId: l.targetId }));

  const showMute = isDefaultProfileRow(tts.profiles, form.id);

  return (
    <div className="flex flex-col gap-4">
      <div data-testid="tts-bind-section" className="flex flex-col gap-1">
        <label className={lblCls}>{t("tts_bind_section")}</label>
        <div className="font-ui text-[11px] text-t4">{t("tts_bind_hint")}</div>
        <LinkBindingPopover
          links={voiceLinks}
          characters={linkCharacters}
          personas={linkPersonas}
          onSetLinks={(newLinks) => {
            void setVoiceTargets(
              newLinks
                .filter(isVoiceMapTarget)
                .map((l) => ({ targetType: l.targetType, targetId: l.targetId })),
            );
          }}
          t={t}
          isMobile={isMobile}
          triggerLabel={t("tts_bind_add")}
        />
      </div>

      {showMute && (
        <div data-testid="tts-mute-section" className="flex flex-col gap-1">
          <label className={lblCls}>{t("tts_mute_section")}</label>
          <div className="font-ui text-[11px] text-t4">{t("tts_mute_hint")}</div>
          <LinkBindingPopover
            links={mutedLinks}
            characters={linkCharacters}
            personas={[]}
            onSetLinks={(newLinks) => {
              void setMutedCharacters(newLinks.map((l) => l.targetId));
            }}
            t={t}
            isMobile={isMobile}
            triggerLabel={t("tts_mute_add")}
          />
        </div>
      )}

      {error !== null && (
        <div data-testid="tts-links-error" className="font-ui text-[12px] text-danger">
          {t("tts_links_error")}: {error}
        </div>
      )}
    </div>
  );
}
