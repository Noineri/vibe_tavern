import { registerBuildPanel } from "../lib/build-panel-registry.js";
import { Icons } from "../components/shared/icons.js";
import { CharacterForm } from "../components/editors/CharacterForm.js";
import { LorebookEditor } from "../components/editors/LorebookEditor.js";

registerBuildPanel({
  id: "character",
  icon: <Icons.Wrench />,
  labelKey: "sidebar_build_char",
  render(ctx) {
    // CharacterForm needs full form context — handled via BuildModeInner wrapper
    // This panel is special: BuildMode still owns the form + save logic
    return null;
  },
});

registerBuildPanel({
  id: "lorebook",
  icon: <Icons.Book />,
  labelKey: "sidebar_build_lore",
  fullBleed: true,
  render({ characterId, chatId, personaId }) {
    return (
      <LorebookEditor
        characterId={characterId}
        chatId={chatId}
        personaId={personaId}
      />
    );
  },
});

registerBuildPanel({
  id: "trace",
  icon: <Icons.Trace />,
  labelKey: "sidebar_build_trace",
  render() {
    // Trace panel is complex — handled via BuildModeInner wrapper
    return null;
  },
});
