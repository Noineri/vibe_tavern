/**
 * TPE-18c: minimal platform signals for features that depend on the OS
 * around the app (not the viewport — useIsMobile owns layout).
 *
 * The narration-library «show file» button hides where no OS file manager
 * exists (the Android app shell runs server + client on-device — there is
 * nothing to reveal into). A desktop browser in a narrow window keeps the
 * button: the file manager lives on the server host regardless.
 */

export function isAndroidUserAgent(userAgent: string): boolean {
  return /Android/i.test(userAgent);
}

export function isAndroidDevice(): boolean {
  return typeof navigator !== "undefined" && isAndroidUserAgent(navigator.userAgent ?? "");
}
