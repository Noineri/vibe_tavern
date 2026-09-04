import React, { useRef, useState } from "react";
import { Icons } from "../shared/icons.js";
import { useChatStore } from "../../stores/index.js";
import { getGatewayBaseUrl } from "../../gateway-client.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { useT } from "../../i18n/context.js";

function formatBytes(bytes: number, decimals = 1) {
  if (!+bytes) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

/** Audio draft chip duration (ST-6): "0:07" / "1:23" from durationMs. */
function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Play/pause toggle for an audio draft chip (owner request 2026-09-06:
 *  listen to the recorded voice note / attached audio file BEFORE sending
 *  it — the sent voice bubble already has a full player). The artwork IS
 *  the button; a hidden <audio> element does the playing, so the media
 *  element (not React state) is the source of truth for play/pause events. */
function AudioDraftPlayButton({ src, name }: { src: string; name: string }) {
  const { t } = useT();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const toggle = () => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) el.pause();
    else void el.play().catch(() => {
      // Autoplay rejection / missing decode support — the icon simply
      // stays in the idle state; nothing to clean up.
    });
  };
  const size = useIsMobile() ? 36 : 48;
  return (
    <>
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        className="hidden"
        data-testid="draft-audio-element"
      />
      <button
        type="button"
        data-testid="draft-audio-play"
        aria-label={playing ? `${t("voice_draft_pause")} — ${name}` : `${t("voice_draft_play")} — ${name}`}
        aria-pressed={playing}
        title={playing ? t("voice_draft_pause") : t("voice_draft_play")}
        onClick={toggle}
        className="flex shrink-0 cursor-pointer items-center justify-center rounded-[5px] bg-s3 text-t2 transition-colors hover:bg-s3/70 hover:text-t1 active:scale-95"
        style={{ width: size, height: size }}
      >
        {playing ? <Icons.pause /> : <Icons.play />}
      </button>
    </>
  );
}

export function AttachmentPreview() {
  const draftAttachments = useChatStore((s) => s.draftAttachments);
  const removeDraftAttachment = useChatStore((s) => s.removeDraftAttachment);
  const isMobile = useIsMobile();
  
  if (draftAttachments.length === 0) return null;

  return (
    <div className="flex w-full items-center gap-2 overflow-x-auto pb-2 pl-3 pr-3 pt-2 scrollbar-hide">
      {draftAttachments.map((att) => (
        <div key={att.id} className="group relative flex shrink-0 items-center gap-2 rounded-lg border border-border2 bg-s2 p-1.5 shadow-sm transition-colors hover:bg-s3" data-testid={att.type === "audio" ? "draft-audio-chip" : undefined}>
          {att.type === "audio" ? (
            <AudioDraftPlayButton src={`${getGatewayBaseUrl()}/api/assets/${att.assetId}`} name={att.name} />
          ) : (
            <img
              src={`${getGatewayBaseUrl()}/api/assets/${att.assetId}`}
              alt={att.name}
              className="rounded-[5px] object-cover"
              style={{ width: isMobile ? 36 : 48, height: isMobile ? 36 : 48 }}
            />
          )}
          <div className="flex flex-col justify-center max-w-[120px] pr-2">
            <span className="truncate font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-t1" title={att.name}>
              {att.name}
            </span>
            <span className="font-ui text-[10px] uppercase tracking-wider text-t3">
              {att.type === "audio" && att.durationMs !== undefined
                ? formatDuration(att.durationMs)
                : formatBytes(att.sizeBytes)}
            </span>
          </div>
          <button
            type="button"
            className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-surface text-t2 shadow-sm transition-colors hover:bg-danger-dim hover:text-danger-text hover:border-danger"
            onClick={() => removeDraftAttachment(att.id)}
          >
            <Icons.Close />
          </button>
        </div>
      ))}
    </div>
  );
}
