import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { RegexPresetRecord, RegexProfileRecord } from "../../../api/types.js";
import { useT } from "../../../i18n/context.js";
import { MasterDetailFooter } from "../../shared/MasterDetailModal.js";
import { Icons } from "../../shared/icons.js";

export const PROFILE_AUTOSAVE_DEBOUNCE_MS = 1000;

type ProfilePatch = Partial<Pick<RegexProfileRecord, "name" | "disabled" | "isGlobal">>;
export type AutosaveStatus = "idle" | "saving" | "saved" | "error";

interface PendingProfileSave {
  id: RegexProfileRecord["id"];
  patch: ProfilePatch;
  previous: RegexProfileRecord;
}

interface ProfileAutosaveOptions {
  update: (id: RegexProfileRecord["id"], patch: ProfilePatch) => Promise<RegexProfileRecord | null>;
  rollback: (save: PendingProfileSave) => void;
  onSaved: () => void;
  onStatus: (status: AutosaveStatus) => void;
}

class ProfileAutosave {
  private pending: PendingProfileSave | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly options: ProfileAutosaveOptions) {}

  queue(id: RegexProfileRecord["id"], patch: ProfilePatch, previous: RegexProfileRecord, immediate: boolean) {
    if (this.pending?.id === id) {
      this.pending = { ...this.pending, patch: { ...this.pending.patch, ...patch } };
    } else {
      this.clearTimer();
      this.pending = { id, patch, previous };
    }
    this.options.onStatus("saving");
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, immediate ? 0 : PROFILE_AUTOSAVE_DEBOUNCE_MS);
  }

  async flush() {
    this.clearTimer();
    await this.drain();
  }

  private clearTimer() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private async drain(): Promise<void> {
    if (this.inFlight) {
      await this.inFlight;
      if (this.pending) await this.drain();
      return;
    }
    const save = this.pending;
    if (!save) return;
    this.pending = null;
    this.inFlight = this.persist(save);
    await this.inFlight;
    this.inFlight = null;
    if (this.pending) await this.drain();
  }

  private async persist(save: PendingProfileSave) {
    try {
      const updated = await this.options.update(save.id, save.patch);
      if (!updated) throw new Error("Profile update did not return a record");
      this.options.onSaved();
      this.options.onStatus("saved");
    } catch {
      this.options.rollback(save);
      this.options.onStatus("error");
    }
  }
}

interface UseProfileAutosaveOptions {
  update: ProfileAutosaveOptions["update"];
  setProfiles: Dispatch<SetStateAction<RegexProfileRecord[]>>;
  onRollback: (id: RegexProfileRecord["id"], previous: RegexProfileRecord) => void;
  onSaved: () => void;
}

/** Owns the Profile-only optimistic autosave lifecycle used by the prompt manager. */
export function useProfileAutosave({ update, setProfiles, onRollback, onSaved }: UseProfileAutosaveOptions) {
  const [status, setStatus] = useState<AutosaveStatus>("idle");
  const autosaveRef = useRef<ProfileAutosave | null>(null);
  if (!autosaveRef.current) {
    autosaveRef.current = new ProfileAutosave({
      update,
      rollback: (save) => onRollback(save.id, save.previous),
      onSaved,
      onStatus: setStatus,
    });
  }

  function queue(profile: RegexProfileRecord, patch: ProfilePatch, immediate: boolean) {
    setProfiles((current) => current.map((item) => item.id === profile.id ? { ...item, ...patch } : item));
    autosaveRef.current?.queue(profile.id, patch, profile, immediate);
  }

  return {
    status,
    queue,
    flush: () => autosaveRef.current?.flush() ?? Promise.resolve(),
    resetStatus: () => setStatus("idle"),
  };
}

function ProfileAutosaveStatus({ status }: { status: AutosaveStatus }) {
  const { t } = useT();
  if (status === "idle") return null;
  return (
    <span role="status" className={status === "error" ? "font-ui text-[calc(var(--ui-fs)-2px)] text-danger" : "font-ui text-[calc(var(--ui-fs)-2px)] text-t3"}>
      {t(
        status === "saving"
          ? "promptManager.regex.profileAutosaveSaving"
          : status === "saved"
            ? "promptManager.regex.profileAutosaveSaved"
            : "promptManager.regex.profileAutosaveFailed",
      )}
    </span>
  );
}

interface ProfileAutosaveFooterProps {
  profile: RegexProfileRecord;
  rules: RegexPresetRecord[];
  status: AutosaveStatus;
  onExport: () => void;
  onDelete: () => void;
  onClose: () => void;
}

export function ProfileAutosaveFooter({ profile, rules, status, onExport, onDelete, onClose }: ProfileAutosaveFooterProps) {
  const { t } = useT();
  return (
    <MasterDetailFooter
      actions={[
        {
          icon: <Icons.Download />,
          label: t("promptManager.regex.profileExport"),
          onClick: onExport,
          disabled: rules.filter((rule) => rule.profileId === profile.id).length === 0,
        },
        {
          icon: <Icons.Trash />,
          label: t("promptManager.regex.profileDelete"),
          onClick: onDelete,
          destructive: true,
        },
      ]}
      onClose={onClose}
      right={<ProfileAutosaveStatus status={status} />}
    />
  );
}
