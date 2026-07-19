/**
 * Owns a hidden `<input type="file">` and exposes an `open()` trigger for the
 * mobile import rail buttons (plan unit IF-3). The caller renders the trigger
 * button and mounts the returned `inputElement`; the hook wires the native
 * picker click-through and forwards the picked file.
 *
 * Mirrors the click-through semantics of the desktop `Dropzone` in
 * `ImportModals.tsx`, with one improvement: the input value is cleared after
 * each change so selecting the same file twice still fires `onChange`.
 *
 * Mobile-only by convention: the hook never calls `useIsMobile` — the caller
 * decides whether to wire it on mobile rails only.
 */
import { createElement, useCallback, useRef } from "react";
import type { ChangeEvent, ReactElement } from "react";

export interface UseMobileFilePickerOptions {
  accept: string;
  onFile: (file: File) => void;
}

export interface UseMobileFilePickerResult {
  open: () => void;
  inputElement: ReactElement;
}

export function useMobileFilePicker({
  accept,
  onFile,
}: UseMobileFilePickerOptions): UseMobileFilePickerResult {
  const inputRef = useRef<HTMLInputElement | null>(null);

  const open = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      // Reset so selecting the same file again fires another `change`.
      // When the user dismisses the native picker, `files` is empty and the
      // value reset is a no-op — nothing reaches `onFile`.
      event.currentTarget.value = "";
      if (file) {
        onFile(file);
      }
    },
    [onFile],
  );

  const inputElement = createElement("input", {
    ref: inputRef,
    type: "file",
    accept,
    className: "hidden",
    onChange: handleChange,
  });

  return { open, inputElement };
}
