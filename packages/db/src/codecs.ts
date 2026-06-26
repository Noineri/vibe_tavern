/**
 * Browser-safe entry point for the VTF codecs.
 *
 * The root barrel (`./index.ts`) re-exports the server-only surfaces
 * (`createDb`, the entity stores, `persistence`, `file-store`, `content-store`)
 * alongside these leaf VTF codecs. Any graph that imports the root barrel —
 * including the web bundle — therefore walks into `bun:sqlite` / `node:fs` /
 * `node:path` and drizzle-orm, which Vite then flags as
 * "externalized for browser compatibility".
 *
 * This sub-path exposes ONLY the leaf VTF codecs (`profile-md` / `greetings` /
 * `instructions` / the folder facade in `vtf/index`), which have zero
 * server-only imports. Browser consumers (apps/web) import from
 * `@vibe-tavern/db/codecs`; server consumers keep importing from the root
 * barrel and are unaffected.
 *
 * The export surface mirrors the codec portion of the root barrel 1:1 so the
 * two stay interchangeable for codec-only use.
 */
export {
	parseProfileMd,
	serializeProfileMd,
	DEFAULT_MES_EXAMPLE_MODE,
	DEFAULT_DEPTH,
	type VtfProfile,
	type ProfileMd,
	type ParsedProfile,
	type FrontmatterEntry,
	type BodySection,
} from './vtf/profile-md.js';
export {
	readInstructions,
	writeInstructions,
	EMPTY_INSTRUCTIONS,
	type VtfInstructions,
} from './vtf/instructions.js';
export {
	compileGreetingsInline,
	splitGreetingsInline,
	greetingsFromCharacter,
	characterFromGreetings,
	type VtfGreeting,
} from './vtf/greetings.js';
export {
	packMonolith,
	unpackMonolith,
	serializeCharacterFolder,
	parseCharacterFolder,
	defaultGreetingName,
	type VtfCharacterContent,
	type FolderFileEntry,
} from './vtf/index.js';
