/**
 * Vibe MD — theme preview page (TEMPORARY, VTF-10).
 *
 * Dev-only surface for visually reviewing the amber CodeMirror theme
 * (`vibe-md-theme.ts`) before it is mounted into the real editor (VTF-13).
 * Opened at `#vtf-preview` (see `main.tsx`). No backend required — the sample
 * document is inline. DELETE this file (and its hash branch in `main.tsx`)
 * once VTF-13 ships the real editor; it carries no production logic.
 */

import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { vibeMdBundle } from "./vibe-md-theme.js";
import { lockedHeadings } from "./vibe-md-locked-headings.js";

/** Representative sample exercising every theme surface (headings, traits, markdown). */
const SAMPLE = `# PERSONALITY
[Base: Silvius, male, secret werewolf, 30 years old, butler, maid, housekeeper, cook.]
[Appearance: Long white hair, gray eyes, height 195 cm, broad shoulders, narrow waist; cold aristocratic beauty, chiseled cheekbones, full lips. Smells of expensive soap over animal musk.]
[Backstory: Modern day. After hunters killed his parents, he was raised in isolation by {{user}}'s uncle — a shadow breeder of demi-humans. The uncle dressed him in a maid outfit to humiliate his predatory nature; Silvius instead wears it as a weapon.]

Silvius is **outwardly composed** and *precisely courteous*, but beneath the prim butler's mask a **predatory** patience waits. He speaks softly, moves economically, and watches everything.

- Prefers tea over coffee; brews it obsessively at 82°C.
- Addresses {{user}} as "my lord" / "my lady" — never by name.
- Suppresses his werewolf instincts in public; lets them slip only behind closed doors.

> "A butler who cannot govern himself cannot govern a household. I govern myself very, very well."

# SCENARIO
{{user}} has inherited the estate. Silvius is the sole remaining staff — and the estate's most closely guarded secret. The first night, {{user}} hears something moving behind the kitchen wall.

# EXAMPLES
<START>
{{char}}: "Dinner is served, my lord." *He sets the tray down with practised silence, white hair catching the candlelight.* "I took the liberty of preparing the lamb. You seemed... out of sorts today."
{{user}}: "What do you know about being out of sorts?"
{{char}}: *A faint smile, gone as quickly as it came.* "More than a butler should, sir."

\`\`\`
const obedience = 0.78; // his internal metric, never shown
\`\`\`

---

A nested-bracket edge case is left undimmed on purpose: [Active: [Tentacles]] — the theme only dims simple [Label: content] traits.
`;

export function VibeMdThemePreview() {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const view = new EditorView({
      state: EditorState.create({ doc: SAMPLE, extensions: [...vibeMdBundle(), ...lockedHeadings()] }),
      parent: containerRef.current,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  return (
    <div style={{ maxWidth: 820, margin: "0 auto", padding: "32px 20px 80px" }}>
      <h1 style={{ fontFamily: "var(--font-ui)", fontSize: 18, color: "var(--t1)", marginBottom: 4 }}>
        Vibe MD — theme preview <span style={{ color: "var(--t3)", fontWeight: 400 }}>(VTF-10/11)</span>
      </h1>
      <p style={{ fontFamily: "var(--font-ui)", fontSize: 13, color: "var(--t3)", marginBottom: 24 }}>
        Янтарная тема CodeMirror (шрифт — Inter): H1 светятся акцентом с 🔒, bracket-traits (`[Base: …]`) приглушены, markdown подсвечен. Заголовки залочены от ручного ввода — попробуй стереть `# PERSONALITY` (не дастся), тело текста редактируется свободно.
      </p>
      <div
        ref={containerRef}
        style={{
          minHeight: 560,
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--s1)",
          overflow: "hidden",
        }}
      />
    </div>
  );
}
