import type { ImportExportRuntimeApi } from "../contract/runtime-api.js";
import type { SessionRuntime } from "../../session/session-runtime.js";

export class ImportExportAdapter implements ImportExportRuntimeApi {
	constructor(private readonly sessionRuntime: SessionRuntime) {}

	importJson = (body: { fileName: string; jsonText: string; chatId?: string; skipExisting?: boolean }) =>
		this.sessionRuntime.importJson(body);

	scanSillyTavernDirectory = (dirPath: string) =>
		this.sessionRuntime.scanSillyTavernDirectory(dirPath);

	importSillyTavernDirectory = (dirPath: string) =>
		this.sessionRuntime.importSillyTavernDirectory(dirPath);
}
