// ────────────────────────────────────────────────────────────────────────────
// Base message-meta badges
// ────────────────────────────────────────────────────────────────────────────
// Registers the core provenance badges that previously were hardcoded inside
// MessageShell's MessageMetadata component. Each badge is variant-scoped: it
// reads from ctx.variant (the selected MessageVariant), the unit of generation.
//
// Registration runs at module load (top-level registerMessageMeta calls), the
// same pattern message-slot-registry uses (see MessageReasoning.tsx,
// CoauthorToolActivitySlot.tsx). This file is imported for its side effects
// from MessageShell.tsx.
//
// The leading timestamp + token-count span are NOT registered here — they are
// always present and rendered by MessageShell itself (not feature-pluggable).
//
// Dice rolls badge (DICE-F10) self-registers in ./dice-rolls.tsx; imported
// here for its side effect so MessageShell's single side-effect import (this
// file) triggers every meta-badge registration.
// ────────────────────────────────────────────────────────────────────────────

import { registerMessageMeta } from "../../../lib/message-meta-registry.js";
import { resolveModelLabel } from "../../../lib/model-resolve.js";

// Side-effect: register the Dice rolls user-message badge (DICE-F10).
import "./dice-rolls.js";

// Provenance: model that produced this variant.
// Visible only for assistant variants that carry a model id.
registerMessageMeta({
  id: "provenance-model",
  order: 10,
  roles: ["assistant"],
  visible: (ctx) => !!ctx.variant?.modelId,
  render: (ctx) => <span>{resolveModelLabel(ctx.variant?.modelId ?? "")}</span>,
});

// Provenance: preset used to assemble the prompt for this variant.
// presetName is pre-resolved by the caller (variant.presetId → name).
registerMessageMeta({
  id: "provenance-preset",
  order: 20,
  roles: ["assistant"],
  visible: (ctx) => !!ctx.presetName,
  render: (ctx) => <span>{ctx.presetName}</span>,
});

// Coauthor provenance: module that produced this variant.
registerMessageMeta({
  id: "coauthor-module",
  order: 30,
  roles: ["assistant"],
  visible: (ctx) => !!ctx.variant?.coauthorModuleId,
  render: (ctx) => <span>{ctx.variant?.coauthorModuleId}</span>,
});

// Coauthor provenance: skill that produced this variant.
registerMessageMeta({
  id: "coauthor-skill",
  order: 40,
  roles: ["assistant"],
  visible: (ctx) => !!ctx.variant?.coauthorSkillId,
  render: (ctx) => <span>{ctx.variant?.coauthorSkillId}</span>,
});
