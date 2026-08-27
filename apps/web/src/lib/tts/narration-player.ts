/**
 * Player interface and HTMLAudioElement implementation for TTS narration.
 * One active element at a time; thin wrapper so tests can inject a fake.
 */

export type SegmentPlayResult = "ended" | "skipped" | "error";

export interface NarrationPlayer {
  play(blob: Blob, rate: number): Promise<SegmentPlayResult>;
  skipCurrent(): void;
  pause(): void;
  resume(): void;
  setRate(rate: number): void;
  dispose(): void;
}

export function createHtmlAudioNarrationPlayer(): NarrationPlayer {
  let audio: HTMLAudioElement | null = null;
  let objectUrl: string | null = null;
  let currentResolve: ((value: SegmentPlayResult) => void) | null = null;
  let currentRate = 1;

  function cleanup(): void {
    if (audio) {
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

  return {
    play(blob: Blob, rate: number): Promise<SegmentPlayResult> {
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
      audio = el;

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
        const playPromise = el.play();
        if (playPromise && typeof playPromise.catch === "function") {
          playPromise.catch(() => {
            detach();
            cleanup();
            currentResolve = null;
            resolve("error");
          });
        }
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
