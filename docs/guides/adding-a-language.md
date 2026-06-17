# Adding a new language

> Companion to [Frontend Architecture](../architecture/frontend.md) and [AD-021](../architecture/decisions.md#ad-021-locale-registry-over-scattered-type-literals-for-i18n) / [AD-022](../architecture/decisions.md#ad-022-flexible-layouts-over-fixed-widths-for-translated-text).

Localization is **registry-driven**, exactly like theming. There is one source of truth — `apps/web/src/i18n/registry.ts` — and every consumer (the `Locale` type, storage validation, browser-language detection, and both language pickers in desktop Tweaks *and* mobile settings) derives from it. Adding a language is two mechanical steps: a JSON file of translated strings plus one array entry. `LocaleProvider` loads the JSON dynamically, so it needs no change.

The two things that are *not* automatic — layout breakage from longer strings, and the pre-React placeholder exception — are documented below; read those sections before you translate.

---

## Where things live (orientation)

```
apps/web/src/
├── i18n/
│   ├── registry.ts                ← LOCALES array — the single source of truth
│   ├── context.tsx                 LocaleProvider + useT() hook
│   ├── locale-helpers.ts           getT()/getLocale() for non-React contexts
│   └── locales/
│       ├── en.json                 flat key → string (copy this, translate every value)
│       └── ru.json
└── (consumers — no edits needed when adding a language)
    ├── main.tsx                    detectLocale() uses isLocale() + detectBrowserLocale()
    ├── components/layout/AppShell.tsx   setLocale() goes through normalizeLocale()
    ├── lib/local-storage.ts        DEFAULT_TWEAKS.lang = DEFAULT_LOCALE
    ├── components/settings/popovers/TweaksPanel.tsx      desktop picker (LOCALES.map)
    └── components/settings/popovers/MobileSettings.tsx   mobile picker (LOCALES.map)
```

Everything below `registry.ts` in that tree adapts automatically. **Do not touch the consumers when adding a language.**

---

## The 2 steps

### 1. Create the translation JSON

Copy `apps/web/src/i18n/locales/en.json` to `<id>.json` (e.g. `de.json`) and translate **every** value. The format is a flat `key → string` map — no nesting, no arrays:

```json
{
  "tweaks_title": "Einstellungen",
  "tweaks_language": "Sprache",
  "loading_app": "Vibe Tavern wird geladen …",
  "..."
}
```

The filename **must** match the `id` you register in step 2 — `LocaleProvider` loads it via `import(\`./locales/${locale}.json\`)`, so a mismatch is a runtime load error (the provider catches it and falls back to raw keys, but that is visibly broken). Leave no English values behind: a missing key renders as the key string itself (`t()` returns its argument when no translation is found), so untranslated keys stick out as literal `tweaks_title`-style text in the UI.

> **Don't merge partial translations incrementally into `en.json`.** New keys are added to `en.json` first (English is the source), then propagated to every other locale file. If you are adding keys as part of a feature, add them to *all* locale files in the same change — a key present in `en.json` but absent in `ru.json` renders as the raw key in Russian.

### 2. Register it

Append a `LocaleDef` to the `LOCALES` array in `apps/web/src/i18n/registry.ts`:

```ts
export const LOCALES: readonly LocaleDef[] = [
  { id: "en", label: "English" },
  { id: "ru", label: "Русский", match: ["ru"] },
  { id: "de", label: "Deutsch", match: ["de"] },  // ← new
];
```

That's it. The language now appears in both pickers, persists across reloads, and is auto-detected from the browser language when `match` is set.

| Field | What it is |
|-------|------------|
| `id` | Persistent id (stored in localStorage as `tweaks.lang`) and the JSON filename. **Lowercase, no region suffix** unless you ship region variants (`pt-br` is fine; `de-DE` is not — use `de`). |
| `label` | Native-language name shown in the picker — **write it in that language**, not English ("Deutsch", not "German"). |
| `match` | BCP-47 prefixes matched against `navigator.language` for auto-detection, case-insensitive. `["de"]` matches both `de` and `de-AT`. **Omit for locales that should never auto-select** (e.g. a deliberately-added language a user must pick explicitly). Without `match`, the locale is reachable only via the picker. |

> **Order matters:** the array order is the display order in both pickers.
>
> **The default** is controlled by `DEFAULT_LOCALE` in the same file (currently `"en"`), not by array position. Most additions should leave the default alone.

---

## Validation: `bun run i18n:check`

The two steps above are mechanical, but copying a JSON file by hand is exactly where drift creeps in — a key forgotten in the new locale, a key defined twice in one file (JSON.parse is last-wins, so the earlier copy silently dies), or a feature merged later that adds a key to `en.json` but not to yours. The locale validator in `scripts/i18n-check.ts` exists to catch all of that before a user sees a raw `tweaks_title` string where a label should be. It runs as part of `bun run check`; invoke it directly with `bun run i18n:check`.

The check parses `apps/web/src` with the TypeScript AST (no type checker, so it's fast and independent of tsconfig) and audits every `t("…")` call against every locale file. It runs five checks — three hard errors (exit 1) and two advisory warnings (exit 0):

| Check | Level | What it catches |
|-------|-------|-----------------|
| `[parity]` | **HARD** | a key present in one locale file but missing in another. `en.json` is the source of truth; every other file must have exactly the same key set. |
| `[duplicate]` | **HARD** | a key defined twice in one file. JSON.parse keeps the last value, so an early duplicate is silently dead copy — this once shipped a double ✓ on `provider_active`. |
| `[missing-key]` | **HARD** | a `t("key")` call in code with no matching entry in a locale file. The raw key string leaks into the UI. |
| `[unused]` | WARN | a key defined but never referenced by any `t()` call. Prefix-aware (a key only reached via `t(\`pos_${x}\`)` or `t("trigger_" + x)` is not flagged), plus a loose scan that counts a key referenced as any string literal (catches registry patterns like `labelKey: "build_scripts"`). |
| `[hardcoded]` | WARN | a raw user-facing string that bypasses i18n — JSX text (`<button>Cancel</button>`), user-facing attributes (`placeholder="…"`, `title=`, `aria-label=`, `alt=`, `label=`), and `toast.*()`/`alert()`/`confirm()` calls with a string-literal first argument. Heuristics skip symbols, URLs, HTML entities, code references, and an enum/role word allowlist. |

When adding a language, your loop is: create the JSON, register it, run `bun run i18n:check`, and fix every `[parity]`, `[duplicate]`, and `[missing-key]` error until the script prints `✓ clean`. The two advisory levels (`[unused]`, `[hardcoded]`) never set exit 1 — they surface candidates for a translator pass but don't block. `[unused]` warnings against your new file almost always mean a key you forgot to delete that was already removed from `en.json`; `[hardcoded]` warnings are pre-existing and not your concern unless you introduced them.

> **The `[dynamic]` warning** appears when a `t()` call uses a value the validator can't resolve statically — `t(panel.labelKey)`, `t(\`prefix${x}\`)`, `t("trigger_" + x)`. These are "verify by hand" notices, not defects; their target keys were sanity-checked at write time. If you add a new dynamically-keyed call site, expect a `[dynamic]` line and confirm the target keys exist.

---

## Layout & text length

**Read [AD-022](../architecture/decisions.md#ad-022-flexible-layouts-over-fixed-widths-for-translated-text) for the full rationale.** The short version: translated text is longer than English — Russian runs ~20–30% longer, and every language breaks the layout in its own way. A layout sized to the English string will clip or overflow the moment a translator fills in a real value.

The rule, enforced by review (there is no linter): **no fixed widths on elements whose text comes from i18n keys.** Let containers size to their content.

```tsx
// ✗ BAD — fits "English" / "Русский" but clips "Українська" or "Deutsch (Sie-Form)"
<DropdownSelect className="w-[110px]" options={langOptions} ... />

// ✓ GOOD — grows with the longest label
<DropdownSelect className="min-w-[110px]" options={langOptions} ... />
```

Concrete guidance:

- **Selectors, buttons, labels:** `w-auto` / `inline-flex` / `flex` + `gap`. Use `min-w` only to guarantee a tap target (e.g. `min-h-[40px]`), never to fit a specific word.
- **Segment controls with equal-width siblings:** `flex-1` on each so they grow together to the widest, instead of pinning one to a fixed width.
- **`truncate` + `max-w`:** only for genuinely unbounded content (user input, message bodies, entity names) — never for fixed UI labels, where hiding the text hides the meaning.
- **Pair a label with a control via `flex` + `gap`,** not by pixel-padding the label to push the control over.

When you add or move UI text, **verify at mobile width in both `en` and your new locale** before considering it done — the narrow viewport surfaces length problems fastest. Use the Playwright MCP server (`browser_resize` to mobile → `browser_snapshot`), or `bun run dev:web` with the viewport toggled. Russian is the stress test: if it fits at 375px wide in Russian, it fits in any current locale.

---

## The pre-React / pre-SPA exception

Two surfaces render **before** the SPA bundle parses and therefore **cannot read the registry or load locale JSON**:

- `services/api/src/server/loading-placeholder.ts` — the server-boot branded page (shown while Bun opens the DB, scans assets, probes providers).
- `apps/web/index.html` `#vt-splash` — the first-paint splash shown until React mounts.

Both intentionally show **only the animated logo, no text.** This is the resolution to the trade-off in [AD-021](../architecture/decisions.md#ad-021-locale-registry-over-scattered-type-literals-for-i18n): any user-visible text here would have to be duplicated inline and hand-synced per language (the i18n JSON is loaded by React at runtime, not available statically), so instead there is nothing to localize. **Do not add a "Loading…" caption to either surface** — it would silently stay English for every non-English user unless you hand-maintain a per-locale inline table alongside the registry, which defeats the single-source-of-truth goal.

The one loading string that *is* localized — `loading_app` — lives in `apps/web/src/app.tsx` and renders inside React, so it flows through the registry like any other key.

---

## Per-locale content logic (not registration)

A few components branch on the active locale for **linguistic or content** reasons that i18n keys can't express:

- `components/build/BuildMode.tsx` — Russian plural forms for "token/токен/токена/токенов" (1 токен, 2 токена, 5 токенов). English has a simple singular/plural; Russian has three forms governed by final-digit rules.
- `components/build/editors/LorebookEditor.tsx` — a `locale === "ru"` branch for locale-specific UI behavior.
- `toLocaleString(locale)` — number/date formatting driven by the locale string, which works for any registered id automatically.

These are **legitimate per-locale logic, not registration sites.** They do not need editing when you add a language *unless your new language has the same kind of need* (e.g. Polish and Czech share Russian's three-form plural rule; Arabic has six). If it does, add a parallel branch — but prefer a general rule over `locale === "x"` ladders where possible (e.g. a plural-form table keyed by locale scales better than nested `if`s). Number/date formatting via `toLocaleString` already scales for free.

---

## Checklist

- [ ] New `apps/web/src/i18n/locales/<id>.json` with **every** key from `en.json` translated; no English values left behind, no raw keys missing.
- [ ] One `LocaleDef` appended to `LOCALES` in `registry.ts`; `id` matches the JSON filename; `label` in the native language; `match` set if the browser language should auto-detect it.
- [ ] `DEFAULT_LOCALE` left as `"en"` unless this is an intentional default change.
- [ ] No fixed-width (`w-[…px]`, `w-[…ch]`) containers on i18n strings touched or added in the same change (AD-022).
- [ ] No "Loading…" text added to `loading-placeholder.ts` or `index.html` (pre-React exception).
- [ ] `bun run i18n:check` prints `✓ clean` for the new file — zero `[parity]`/`[duplicate]`/`[missing-key]` errors. (`[unused]`/`[hardcoded]` warnings are advisory and don't block.)
- [ ] `bun run typecheck` green.
- [ ] Verified in `bun run dev`: the new option appears in **both** the desktop Tweaks panel and mobile settings; it persists across reload; selecting it switches the UI text; with the browser language set to match `match[]`, a fresh profile auto-detects it.
- [ ] Checked at mobile width (375px) in the new locale — no clipping, wrapping, or overflow in the areas the change touches.
