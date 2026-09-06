/**
 * Player interface and HTMLAudioElement implementation for TTS narration.
 * One active element at a time; thin wrapper so tests can inject a fake.
 *
 * TPE-18b: the player grows three OPTIONAL capabilities — volume, seek
 * and position/duration reporting. Optional (not required) so the existing
 * windowless fakes keep compiling: the orchestrator guards every one and
 * falls back (segment-start jumps when seek is unavailable, sliver
 * timeline when durations are unknown).
 */

export type SegmentPlayResult = "ended" | "skipped" | "error";

/** Play options for one segment — TPE-18b seek support. */
export interface SegmentPlayOptions {
  /** Start offset in seconds (seek landing inside the segment). */
  startAt?: number;
  /** Position callback (~4 Hz via timeupdate) for the live progress bar. */
  onTime?: (positionSec: number) => void;
}

/** Live position snapshot of the current element (TPE-18b). */
export interface PlaybackPosition {
  position: number;
  duration: number | null;
}

export interface NarrationPlayer {
  play(blob: Blob, rate: number, options?: SegmentPlayOptions): Promise<SegmentPlayResult>;
  skipCurrent(): void;
  pause(): void;
  resume(): void;
  setRate(rate: number): void;
  /** TPE-18b: global narration volume 0..1 — applied to the live element
   *  and remembered for every element created afterwards. */
  setVolume?(volume: number): void;
  /** TPE-18b: jump the LIVE element to an offset (same-segment seek). */
  seekTo?(offsetSec: number): void;
  /** TPE-18b: current element position (null when nothing is loaded). */
  getPosition?(): PlaybackPosition | null;
  /** TPE-18b: background duration probe for a queued blob (metadata only,
   *  never audible). Null when the duration cannot be determined. */
  probeDuration?(blob: Blob): Promise<number | null>;
  dispose(): void;
}

/** Failure guard for duration metadata (TPE-18b): a blob whose metadata
 *  never loads resolves the probe as unknown instead of hanging the bar. */
export const NARRATION_METADATA_TIMEOUT_MS = 4000;

export function createHtmlAudioNarrationPlayer(options?: { metadataTimeoutMs?: number }): NarrationPlayer {
  const metadataTimeoutMs = options?.metadataTimeoutMs ?? NARRATION_METADATA_TIMEOUT_MS;
  let audio: HTMLAudioElement | null = null;
  let objectUrl: string | null = null;
  let currentResolve: ((value: SegmentPlayResult) => void) | null = null;
  let currentRate = 1;
  /** TPE-18b: store-level volume, applied to every element at creation. */
  let currentVolume = 1;

  function cleanup(): void {
    if (audio) {
      audio.ontimeupdate = null;
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
    audio = null;
  }

  function finiteDuration(value: number): number | null {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
  }

  return {
    play(blob: Blob, rate: number, playOptions?: SegmentPlayOptions): Promise<SegmentPlayResult> {
      // Ensure only one active element.
      if (currentResolve) {
        const prev = currentResolve;
        currentResolve = null;
        cleanup();
        // Previous play was interrupted; resolve it as skipped so the
        // orchestrator can advance.
        prev("skipped");
      } else {
        cleanup();
      }
      currentRate = rate;
      objectUrl = URL.createObjectURL(blob);
      const el = new Audio(objectUrl);
      el.playbackRate = rate;
      el.volume = currentVolume;
      audio = el;
      const onTime = playOptions?.onTime;
      if (onTime) {
        el.ontimeupdate = () => {
          try {
            onTime(el.currentTime);
          } catch {
            // A throwing progress listener must not kill playback.
          }
        };
      }
      const startAt = playOptions?.startAt ?? 0;

      return new Promise<SegmentPlayResult>((resolve) => {
        currentResolve = resolve;
        const onEnded = (): void => {
          detach();
          cleanup();
          currentResolve = null;
          resolve("ended");
        };
        const onError = (): void => {
          detach();
          cleanup();
          currentResolve = null;
          resolve("error");
        };
        function detach(): void {
          el.removeEventListener("ended", onEnded);
          el.removeEventListener("error", onError);
        }
        el.addEventListener("ended", onEnded);
        el.addEventListener("error", onError);
        const begin = (): void => {
          const playPromise = el.play();
          if (playPromise && typeof playPromise.catch === "function") {
            playPromise.catch(() => {
              detach();
              cleanup();
              currentResolve = null;
              resolve("error");
            });
          }
        };
        if (startAt > 0) {
          // TPE-18b seek landing: wait for metadata before starting so
          // the offset applies to a known timeline (first plays never
          // seek, so first-audio latency is unaffected). Guarded by the
          // metadata timeout — a blob without metadata starts at 0.
          let settled = false;
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            begin();
          }, metadataTimeoutMs);
          el.addEventListener(
            "loadedmetadata",
            () => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              try {
                el.currentTime = startAt;
              } catch {
                // An unsettable clock starts at 0 — audible beats silent.
              }
              begin();
            },
            { once: true },
          );
          return;
        }
        begin();
      });
    },

    skipCurrent(): void {
      if (currentResolve) {
        const resolve = currentResolve;
        currentResolve = null;
        cleanup();
        resolve("skipped");
      } else {
        cleanup();
      }
    },

    pause(): void {
      if (audio) audio.pause();
    },

    resume(): void {
      if (audio) {
        const p = audio.play();
        if (p && typeof p.catch === "function") {
          p.catch(() => {
            // Play may fail if interrupted; let the error handler resolve.
          });
        }
      }
    },

    setRate(rate: number): void {
      currentRate = rate;
      if (audio) audio.playbackRate = rate;
    },

    setVolume(volume: number): void {
      currentVolume = volume;
      if (audio) audio.volume = volume;
    },

    seekTo(offsetSec: number): void {
      if (!audio) return;
      try {
        audio.currentTime = Math.max(0, offsetSec);
      } catch {
        // An unsettable clock keeps playing from where it is.
      }
    },

    getPosition(): PlaybackPosition | null {
      if (!audio) return null;
      let position = 0;
      try {
        position = audio.currentTime;
      } catch {
        return null;
      }
      if (typeof position !== "number" || !Number.isFinite(position)) return null;
      return { position, duration: finiteDuration(audio.duration) };
    },

    probeDuration(blob: Blob): Promise<number | null> {
      // Metadata-only scratch element: preloaded, never appended, never
      // played. Every path revokes the object URL.
      return new Promise<number | null>((resolve) => {
        let settled = false;
        const done = (value: number | null): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try {
            probe.removeAttribute("src");
            probe.load();
          } catch {
            // Teardown is best-effort; the URL revoke below is the must.
          }
          URL.revokeObjectURL(url);
          resolve(value);
        };
        const timer = setTimeout(() => done(null), metadataTimeoutMs);
        let url: string;
        let probe: HTMLAudioElement;
        try {
          url = URL.createObjectURL(blob);
          probe = new Audio(url);
        } catch {
          clearTimeout(timer);
          resolve(null);
          return;
        }
        probe.preload = "metadata";
        probe.addEventListener("loadedmetadata", () => done(finiteDuration(probe.duration)), { once: true });
        probe.addEventListener("error", () => done(null), { once: true });
      });
    },

    dispose(): void {
      if (currentResolve) {
        const resolve = currentResolve;
        currentResolve = null;
        resolve("skipped");
      }
      cleanup();
    },
  };
}
