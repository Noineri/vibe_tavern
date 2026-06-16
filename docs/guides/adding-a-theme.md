# Adding a new UI theme

> Companion to [Frontend Architecture](../architecture/frontend.md).
> Read this before adding a color theme — the registry design means most additions are one CSS file + one array entry.

Theming is **registry-driven**. There is exactly one source of truth — `apps/web/src/themes/registry.ts` — and every consumer (storage, the `<html>` class, the theme picker in desktop Tweaks *and* mobile settings) derives from it. Adding a theme is two mechanical steps plus a CSS file. The two gotchas that historically bit us are documented in [§ The two traps](#the-two-traps) below; read those before writing CSS.

---

## Where things live (orientation)

```
apps/web/src/
├── styles.css                     @import each theme CSS file here; body background
├── themes/
│   ├── registry.ts                ← THEMES array — the single source of truth
│   ├── dark.css                   :root                 (default — no class)
│   ├── light.css                  :root.light
│   └── glass-purple.css           :root.glass-purple
└── (consumers — no edits needed when adding a theme)
    ├── lib/local-storage.ts       readSavedTheme() validates via normalizeTheme()
    ├── hooks/use-vibe-tavern-app.ts applyThemeClass() — exclusive class switch
    ├── components/settings/popovers/TweaksPanel.tsx       desktop picker (THEMES.map)
    └── components/settings/popovers/MobileSettings.tsx    mobile picker (THEMES.map)
```

Everything below `registry.ts` in that tree adapts automatically. **Do not touch the consumers when adding a theme.**

---

## The 3 steps

### 1. Create the theme CSS file

Add `apps/web/src/themes/<name>.css`. The selector is `:root.<name>`. Mirror the token set of `dark.css` / `light.css` — every `--*` custom property the UI uses must be defined (copy the full block from an existing theme and adjust values). The relevant groups: backgrounds (`--bg`, `--surface`, `--s2`, `--s3`), borders (`--border`, `--border2`), text (`--t1`–`--t4`, `--msg-t1/2`), accent (`--accent`, `--accent-t`, `--accent-dim`, `--accent-hover`), danger/success/info/warning, shadows, markdown colors, syntax-highlight colors.

```css
:root.my-theme {
  --bg:        oklch(0.16 0.02 270);
  --surface:   oklch(0.20 0.02 270);
  /* …full token set… */
}
```

### 2. Import it

Add one line to `apps/web/src/styles.css`, next to the existing theme imports:

```css
@import "./themes/my-theme.css";
```

### 3. Register it

Append a `ThemeDef` to the `THEMES` array in `apps/web/src/themes/registry.ts`:

```ts
export const THEMES: readonly ThemeDef[] = [
  { id: "light",    className: "light",    icon: "sun" },
  { id: "dark",     className: "",         icon: "moon" },
  { id: "glass-purple", className: "glass-purple", icon: "sparkles" },
  { id: "my-theme", className: "my-theme", icon: "star" },  // ← new
];
```

That's it. The theme now appears in both pickers, persists across reloads, and switches exclusively.

| Field | What it is |
|-------|------------|
| `id` | Persistent id (stored in localStorage). Used as the segment-control value. **kebab-case.** |
| `className` | CSS class applied to `<html>`. **Must match the `:root.<className>` selector.** Empty string `""` for the default theme only (one theme — currently `dark` — must have no class, see trap #1). |
| `icon` | Key into the `Ic` icon set (`apps/web/src/components/shared/icons.tsx`). Resolved via the `Icons` proxy, so either casing works. |

> **Order matters:** the array order is the display order in the segment control.

---

## The two traps

These are the two things that look optional but are load-bearing. Both have shipped bugs. Read before writing CSS.

### Trap #1 — `--bg` must be a solid color, not a gradient

The utility `bg-bg` compiles to `background-color: var(--bg)`. A `radial-gradient(...)` is **not a valid `<color>`**, so the browser silently drops it — and any element using `bg-bg` (the chat input, modals) becomes transparent and merges with whatever is behind it. The same `--bg` is also used as an SVG `fill` (the sliders-icon knob), where a gradient is equally invalid.

**If your page wants a gradient background** (as glass-purple does), put the gradient in a separate token and apply it only via the `background` shorthand on `<body>`:

```css
:root.my-theme {
  --bg:       oklch(0.14 0.02 270);   /* solid color — works as background-color + SVG fill */
  --page-bg:  radial-gradient(circle at 50% 0%, oklch(0.18 0.02 270), oklch(0.12 0.015 265));
}
```

```css
/* styles.css — already wired with a fallback, do not change: */
html, body { background: var(--page-bg, var(--bg)); }
```

Themes without `--page-bg` fall back to their solid `--bg` — so dark/light are unaffected. Never put a gradient directly in `--bg`.

### Trap #2 — exactly one theme has `className: ""`; switching is exclusive

The default theme (`dark`) targets the bare `:root` selector and therefore needs **no class** — its `ThemeDef.className` is `""`. Every other theme carries a class that matches `:root.<className>`.

Switching is **exclusive**: `applyThemeClass()` removes *every* theme class from `<html>` before adding the active one. This replaced an older binary `classList.toggle("light", …)` that only worked for two themes — with a third theme, toggling `light` on/off left stale classes and the themes fought. **Never** apply a theme class with `classList.add`/`toggle` directly; always go through `applyThemeClass()`, and never give a second theme an empty `className`.

---

## When you need a new icon

The `icon` field references the hand-written set in `apps/web/src/components/shared/icons.tsx` (`Ic`). If none fits:

1. Add an entry to `Ic` following the existing convention: `viewBox="0 0 16 16"`, `stroke="currentColor"`, `strokeWidth` ~1.5, single-line JSX.
2. Reference it by its key (e.g. `icon: "coffee"`).

There is no external icon library and no online catalog; to preview the full set, run the icon-gallery generator (see the repo root or ask).

---

## Checklist

- [ ] New `apps/web/src/themes/<name>.css` with the **full** token set, selector `:root.<name>`.
- [ ] `--bg` is a solid color. Gradient (if any) is in `--page-bg` only.
- [ ] `@import` added to `apps/web/src/styles.css`.
- [ ] One `ThemeDef` appended to `THEMES` in `registry.ts`; `className` matches the selector and is **non-empty** (unless this is intentionally the new default).
- [ ] `bun run typecheck` green.
- [ ] Visually verified in `bun run dev`: the new option appears in **both** the desktop Tweaks panel and the mobile settings; it persists across reload; switching to/from it does not leave a stale class.
