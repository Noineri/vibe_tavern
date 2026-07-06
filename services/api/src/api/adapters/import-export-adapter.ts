import type { ImportExportRuntimeApi } from "../contract/runtime-api.js";
import type { SessionRuntime } from "../../runtime/session/session-runtime.js";

export class ImportExportAdapter implements ImportExportRuntimeApi {
	constructor(private readonly sessionRuntime: SessionRuntime) {}

	importJson = (body: { fileName: string; jsonText: string; chatId?: string; skipExisting?: boolean; lean?: boolean }) =>
		this.sessionRuntime.importJson(body);

	importJsonBatch = (body: { items: Array<{ fileName: string; jsonText: string; chatId?: string; skipExisting?: boolean }>; lean?: boolean }) =>
		this.sessionRuntime.importJsonBatch(body);

	scanSillyTavernDirectory = (dirPath: string) =>
		this.sessionRuntime.scanSillyTavernDirectory(dirPath);

	importSillyTavernDirectory = (dirPath: string) =>
		this.sessionRuntime.importSillyTavernDirectory(dirPath);

	importSillyTavernDirectoryStream = (dirPath: string) =>
		this.sessionRuntime.importSillyTavernDirectoryStream(dirPath);
}
