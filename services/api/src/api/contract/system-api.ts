/**
 * System-level runtime surface — host integration that belongs to no domain.
 *
 * Currently one action: opening the server's data directory in the OS file
 * manager, the «Открыть папку данных» action in the About settings section.
 * Desktop-only by design: the Android APK's data directory is private to the
 * app process and no file manager can show it, so the adapter answers
 * `{ available: false }` there and the section hides the button as well.
 */

export type OpenDataDirResult =
	| { opened: true }
	| { available: false }
	| { error: string };

export interface SystemRuntimeApi {
	openDataDir: () => Promise<OpenDataDirResult>;
}
