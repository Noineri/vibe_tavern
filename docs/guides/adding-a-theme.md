# Adding a new UI theme

> Companion to [Frontend Architecture](../architecture/frontend.md).
> Read this before adding a color theme — the registry design means most additions are one CSS file + one array entry.

Theming is **registry-driven**. There is exactly one source of truth — `apps/web/src/themes/registry.ts` — and every consumer (storage, the `<html>` class, the theme picker in desktop Tweaks *and* mobile settings) derives from it. Adding a theme is two mechanical steps plus a CSS file. The three traps that historically shipped bugs are documented in [§ The three traps](#the-three-traps) below; read those before writing CSS. If your theme uses a gradient or animated background, also read [§ Page-background gradients and transparency](#page-background-gradients-and-transparency).

---

## Where things live (orientation)

```
apps/web/src/
├── styles.css                     @import each theme CSS file here; body background
├── themes/
│   ├── registry.ts                ← THEMES array — the single source of truth
│   ├── coffee.css                  :root                 (default — no class)
│   ├── light.css                  :root.light
│   └── mystic-night.css           :root.mystic-night
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

Add `apps/web/src/themes/<name>.css`. The selector is `:root.<name>`. Mirror the token set of `coffee.css` / `light.css` — every `--*` custom property the UI uses must be defined (copy the full block from an existing theme and adjust values). The relevant groups: backgrounds (`--bg`, `--surface`, `--s2`, `--s3`; optionally `--page-bg` for a page gradient — see [§ Page-background gradients and transparency](#page-background-gradients-and-transparency)), borders (`--border`, `--border2`), text (`--t1`–`--t4`, `--msg-t1/2`), accent (`--accent`, `--accent-t`, `--accent-dim`, `--accent-hover`), danger/success/info/warning, shadows, markdown colors, syntax-highlight colors.

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
  { id: "coffee",   className: "",         icon: "coffee" },
  { id: "mystic-night", className: "mystic-night", icon: "sparkles" },
  { id: "my-theme", className: "my-theme", icon: "star" },  // ← new
];
```

That's it. The theme now appears in both pickers, persists across reloads, and switches exclusively.

| Field | What it is |
|-------|------------|
| `id` | Persistent id (stored in localStorage). Used as the segment-control value. **kebab-case.** |
| `className` | CSS class applied to `<html>`. **Must match the `:root.<className>` selector.** Empty string `""` for the default theme only (one theme — currently `coffee` — must have no class, see trap #1). |
| `icon` | Key into the `Ic` icon set (`apps/web/src/components/shared/icons.tsx`). Resolved via the `Icons` proxy, so either casing works. |

> **Order matters:** the array order is the display order in the segment control.

---

## The three traps

These look optional but are load-bearing. Each has shipped a bug. Read before writing CSS.

### Trap #1 — `--bg` must be a solid color, not a gradient

The utility `bg-bg` compiles to `background-color: var(--bg)`. A `radial-gradient(...)` is **not a valid `<color>`**, so the browser silently drops it — and any element using `bg-bg` (the chat input, modals) becomes transparent and merges with whatever is behind it. The same `--bg` is also used as an SVG `fill` (the sliders-icon knob), where a gradient is equally invalid.

**If your page wants a gradient background** (as mystic-night does), put the gradient in a separate token and apply it only via the `background` shorthand on `<body>`:

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

Themes without `--page-bg` fall back to their solid `--bg` — so coffee/light are unaffected. Never put a gradient directly in `--bg`.

### Trap #2 — exactly one theme has `className: ""`; switching is exclusive

The default theme (`coffee`) targets the bare `:root` selector and therefore needs **no class** — its `ThemeDef.className` is `""`. Every other theme carries a class that matches `:root.<className>`.

Switching is **exclusive**: `applyThemeClass()` removes *every* theme class from `<html>` before adding the active one. This replaced an older binary `classList.toggle("light", …)` that only worked for two themes — with a third theme, toggling `light` on/off left stale classes and the themes fought. **Never** apply a theme class with `classList.add`/`toggle` directly; always go through `applyThemeClass()`, and never give a second theme an empty `className`.

> **Renaming a theme:** the `id` is what's stored in localStorage. If you change an existing id (e.g. the espresso palette was renamed `dark` → `coffee` once a third theme made "dark" misleading), users with the old id saved fall through to `normalizeTheme()` → `DEFAULT_THEME`, so they land on the default theme automatically — only safe when the default theme *is* the renamed one, otherwise they'd land on the wrong palette.

### Trap #3 — the root app `<div>` must stay transparent

`--page-bg` paints `<body>`, but it only reaches the eye through the root `<div>` in `AppShell.tsx`. That div is deliberately `className="flex text-t1 font-ui"` with **no background**. If someone re-adds `bg-bg` (opaque) to it, it masks `--page-bg` completely and **every gradient theme ships invisible** — exactly the bug that hid mystic-night's gradient for its entire life until it was fixed. Never add `bg-bg` (or any opaque background) to the root app div. The full picture is in [§ Page-background gradients and transparency](#page-background-gradients-and-transparency).

---

## Page-background gradients and transparency

A theme's page background is **live**: when `--page-bg` is set, it paints the whole viewport through a deliberate transparency stack. Understanding that stack is the difference between a gradient that glows and one that's invisible.

### The transparency stack

```
<body>                        ← paints var(--page-bg, var(--bg)) — the gradient lives here
└─ root <div> (AppShell)      ← transparent (no bg-bg — trap #3)
   ├─ <Sidebar>               ← opaque --surface panel
   └─ <main>
      ├─ <TopBar>             ← opaque --surface panel
      └─ chat reading area    ← transparent — the gradient glows through here
         └─ <InputArea>       ← opaque --surface panel
```

The gradient shows only in the gaps between opaque panels — chiefly the chat reading area. The panels (`Sidebar`, `TopBar`, `InputArea`, AI message surfaces) carry their own opaque `--surface` and sit *above* the gradient. This is intentional: text rests on solid color for readability while the background supplies atmosphere.

- A theme **without** `--page-bg` (coffee, light) gets a flat solid `--bg` on `<body>` — the stack still holds, the background is simply uniform.
- A theme **with** `--page-bg` gets a gradient visible through the reading area.

### Gradient stops must clear the just-noticeable difference

Stops too close in lightness read as flat. mystic-night originally ran `oklch(0.18 …) → oklch(0.13 …)` — a 0.05 spread that was invisible; raising the top stop to `0.24` made the glow perceptible. **Aim for ≥ 0.06–0.08 lightness between the brightest and darkest stops**, or the gradient ships invisible (and looks like a bug — it did).

### Alpha on surfaces — the "glass" look

Tokens consumed as `background-color` (via the `bg-*` Tailwind utilities: `bg-surface`, `bg-user-bg`, `bg-s2`, …) **do accept alpha**, so translucent surfaces work:

```css
--user-bg: oklch(0.23 0.025 330 / 60%);  /* user bubble lets the gradient bleed through */
```

What does **not** work: a gradient inside any color-consumed token. `bg-accent`, `bg-user-bg`, `bg-surface` all compile to `background-color: var(--…)`, and a gradient is not a valid `<color>` — it's silently dropped (Trap #1, generalized beyond `--bg`). Gradients belong only in `--page-bg`.

> mystic-night keeps `--user-bg` opaque by maintainer decision. Translucent surfaces are a per-theme choice, not a requirement — but the mechanism is there.

### Animated gradients (lava-lamp / aurora)

`--page-bg` accepts any `background-image`, including **layered** radial gradients. Animate `background-position` with `background-size > 100%` and the blobs drift. Because `--page-bg` is consumed by a global `background` shorthand on `<body>`, set `background-size` and `animation` on `<body>` scoped under your theme selector so the cascade wins over the global rule:

```css
:root.lava-lamp {
  /* four layers: three drifting color blobs + a dark opaque base */
  --page-bg:
    radial-gradient(circle at 20% 30%, oklch(0.40 0.12 300 / 70%), transparent 45%),
    radial-gradient(circle at 80% 60%, oklch(0.36 0.14 25  / 65%), transparent 45%),
    radial-gradient(circle at 50% 80%, oklch(0.32 0.10 160 / 60%), transparent 50%),
    oklch(0.12 0.02 285);
}

/* size + animation go on body, scoped to the theme so they don't leak */
:root.lava-lamp body {
  background-size: 180% 180%;
  animation: lava-drift 18s ease-in-out infinite;
}

@media (prefers-reduced-motion: reduce) {
  :root.lava-lamp body { animation: none; }
}

@keyframes lava-drift {
  0%, 100% { background-position:   0% 0%, 100% 100%, 50% 50%; }
  50%      { background-position: 100% 50%,   0% 50%, 50% 0%; }
}
```

Validated against the running app: the three blobs render in the reading area, drift over ~18s, panels stay opaque, text stays readable. Keep the base layer opaque and dark, and keep blob alpha ≤ ~70% so text contrast holds. Always respect `prefers-reduced-motion`.

---

## When you need a new icon

The `icon` field references the icon set in `apps/web/src/components/shared/icons.tsx` (`Ic`). The set is **adapted from [Lucide](https://lucide.dev) / Feather** — most entries are Lucide's 24×24 source rescaled to a 16×16 viewBox (×2/3); a few (e.g. `brain`, `flame`) keep Lucide's native 24×24 where the extra detail reads better at 13px. All entries share `stroke="currentColor"`, strokeWidth ~1.5–2, and single-line JSX. If none fits:

1. Grab the SVG from Lucide (or Feather) and add an entry to `Ic` following the existing convention — rescale to 16×16 or keep native 24×24, whichever reads clearly at the ~13px picker size.
2. Reference it by its key (e.g. `icon: "flame"`).

Lucide is ISC-licensed and Feather is MIT, so no attribution is required in source — but matching their stroke/round-cap style keeps the set visually consistent.

---

## Checklist

- [ ] New `apps/web/src/themes/<name>.css` with the **full** token set, selector `:root.<name>`.
- [ ] `--bg` is a solid color. No gradient inside any color-consumed token (`--bg`, `--surface`, `--accent`, `--user-bg`, …) — gradients only in `--page-bg`.
- [ ] If the theme sets `--page-bg`: brightest-vs-darkest stop differs by **≥ 0.06** lightness (else it ships invisible).
- [ ] If the gradient is animated: `background-size` + `animation` are scoped to `:root.<theme> body`, and a `prefers-reduced-motion` block disables them.
- [ ] The root app div in `AppShell.tsx` was **not** given a `bg-bg` (it would mask `--page-bg`).
- [ ] `@import` added to `apps/web/src/styles.css`.
- [ ] One `ThemeDef` appended to `THEMES` in `registry.ts`; `className` matches the selector and is **non-empty** (unless this is intentionally the new default).
- [ ] `bun run typecheck` green.
- [ ] Visually verified in `bun run dev`: the new option appears in **both** the desktop Tweaks panel and the mobile settings; it persists across reload; switching to/from it does not leave a stale class.
