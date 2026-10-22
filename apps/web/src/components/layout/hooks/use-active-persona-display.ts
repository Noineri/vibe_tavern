/**
 * The active persona as the app shell shows it — name + avatar. ONE derivation
 * shared by the desktop sidebar footer (`Sidebar`) and the mobile rail's bottom
 * panel (`Rail`), so the two launchers can never drift.
 *
 * Source precedence (unchanged from the sidebar's original inline version):
 * the active chat's persona (`useChatMeta().persona`) wins; otherwise the
 * bootstrap persona flagged `defaultForNewChats`, else the first bootstrap
 * persona; otherwise the `no_persona` label with no avatar.
 */
import { initials } from "../app-shell-helpers.js";
import { resolveEntityAvatarUrl } from "../../../lib/avatar.js";
import { useT } from "../../../i18n/context.js";
import { useBootstrapStore } from "../../../stores/api-actions/bootstrap-actions.js";
import { useChatMeta } from "../../../stores/chat-selectors.js";

export interface ActivePersonaDisplay {
  /** The persona's name, or the translated `no_persona` label. */
  readonly name: string;
  /** Resolved avatar URL, or `null` (no persona / no avatar) — render `fallback`. */
  readonly avatarSrc: string | null;
  /** Initials of `name`, shown when there is no avatar. */
  readonly fallback: string;
}

export function useActivePersonaDisplay(): ActivePersonaDisplay {
  const { t } = useT();
  const snapshot = useChatMeta();
  const bootstrapPersonas = useBootstrapStore((s) => s.personas);
  const activePersona = bootstrapPersonas?.find((p) => p.defaultForNewChats) ?? bootstrapPersonas?.[0];
  const name = snapshot?.persona?.name ?? activePersona?.name ?? t("no_persona");
  const personaForAvatar = snapshot?.persona ?? activePersona ?? null;
  const avatarSrc = personaForAvatar
    ? resolveEntityAvatarUrl({ kind: "personas", id: personaForAvatar.id, avatarExt: personaForAvatar.avatarExt, avatarAssetId: personaForAvatar.avatarAssetId, updatedAt: personaForAvatar.updatedAt })
    : null;
  return { name, avatarSrc, fallback: initials(name) };
}
