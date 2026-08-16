import { registerBuildPanel } from "../lib/build-panel-registry.js";
import { Icons } from "../components/shared/icons.js";
import { CharacterForm } from "../components/build/editors/CharacterForm.js";
import { LorebookEditor } from "../components/build/editors/LorebookEditor.js";
import { InsightsPanel } from "../components/build/editors/InsightsPanel.js";
import { ExperienceEditor } from "../components/build/editors/ExperienceEditor.js";

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
  id: "insights",
  icon: <Icons.Target />,
  labelKey: "sidebar_build_insights",
  render() {
    // InsightsPanel reads the live chat config from the snapshot store
    // directly, so it needs nothing from the BuildPanelContext (it shows an
    // empty state when no chat is active).
    return <InsightsPanel />;
  },
});

registerBuildPanel({
  id: "experience",
  icon: <Icons.Stack />,
  labelKey: "sidebar_build_experience",
  fullBleed: true,
  render() {
    // Global authoring surface for interactive rules + visuals (IR-81C). It is
    // deliberately context-free: scripts/visuals are global resources here,
    // and per-chat activation stays in Chat Add-ons (ExperienceAssignment).
    return <ExperienceEditor />;
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
