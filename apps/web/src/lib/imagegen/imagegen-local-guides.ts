import type Resources from "../../i18n/resources.js";

/** Typed i18n key for the image-gen local-server namespace — a typo'd or
 *  missing key is a compile error (same pattern as the STT guides). */
export type ImageGenI18nKey = keyof Resources["en"];

/** The two OS families the launch commands differentiate between (the STT
 *  twin reuses the TTS OS detector — same here). */
export type ImageGenOsKind = "windows" | "unix";

/** One step of the setup reference: a heading, per-OS command lists (each
 *  command gets its own copy button), and an optional note. */
export interface ImageGenHelpStep {
  /** i18n key of the step heading. */
  titleKey: ImageGenI18nKey;
  commands: Record<ImageGenOsKind, string[]>;
  /** Optional i18n note rendered under the commands. */
  noteKey?: ImageGenI18nKey;
}

/** A local image-gen server family's setup guide (PG-1). Facts verified
 *  against the upstream launchers' own docs (each UI documents `--api`
 *  exposing the /sdapi/v1 surface and `--listen` accepting non-localhost
 *  connections):
 *  - AUTOMATIC1111 — webui.sh / webui-user.bat (Windows launcher reads
 *    COMMANDLINE_ARGS).
 *  - Forge and ReForge — launch.py (Windows rides the same
 *    webui-user.bat COMMANDLINE_ARGS flow).
 *  - SD.Next — webui.py / webui.bat.
 *  ComfyUI gets its own card when its adapter lands (the report's
 *  "cards join later" rule) — it is NOT an /sdapi/v1 dialect. */
export interface ImageGenServerGuide {
  id: string;
  name: string;
  /** i18n key of the one-line "what this is" description. */
  descriptionKey: ImageGenI18nKey;
  /** Default endpoint (the family's shared default port 7860). */
  endpoint: string;
  run: ImageGenHelpStep;
}

export const IMAGE_GEN_SERVER_GUIDES: ImageGenServerGuide[] = [
  {
    id: "a1111",
    name: "A1111-compatible UIs",
    descriptionKey: "image_gen_local_desc_a1111",
    endpoint: "http://127.0.0.1:7860",
    run: {
      titleKey: "image_gen_local_step_run",
      commands: {
        unix: [
          "./webui.sh --api --listen",
          "python launch.py --api --listen",
          "python webui.py --api --listen",
        ],
        windows: ["set COMMANDLINE_ARGS=--api --listen"],
      },
      noteKey: "image_gen_local_note_windows_args",
    },
  },
];
