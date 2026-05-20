# Lorebook & Scripts Panel — Final UI Concept

## Ключевые идеи

1. **Sidebar меняется в Build Mode** (и на десктопе, и на мобилке) — показывает навигацию билд-секций вместо персонажей/чатов
2. **Таб Lorebooks/Scripts** — клик анимируется в заголовок + back-кнопка
3. **Scope-табы** — вертикально (Global, Character, Persona, Chat)
4. **Лорбуки** — горизонтальные аккордеоны, внутри — карточки entries
5. **Simple / Advanced** режимы редактирования entry

---

## 1. Sidebar в Build Mode (десктоп)

### Play Mode (текущее поведение — не меняется)
```
┌─ Sidebar ──────────────┐
│ 🔍 Search characters   │
│                         │
│ 👤 Alice                │
│ 👤 Bob                  │
│ 👤 Charlie              │
│                         │
│ ── Recent Chats ──      │
│ 💬 Alice #3      →      │
│ 💬 Bob #1        →      │
│                         │
│ [Personas] [Presets]    │
└─────────────────────────┘
```

### Build Mode (новое поведение)
```
┌─ Sidebar ──────────────┐
│                         │
│ ── Build Sections ──    │
│                         │
│ 📝 Character Form   ●   │  ← активная секция подсвечена
│ 📚 World & Logic        │
│ 🔍 Prompt Trace         │
│ 🔧 Tools                │
│                         │
│ ── Quick Jump ──        │
│                         │
│ 💬 Back to Chat   →     │  ← выход из build mode
│                         │
│ [Presets] [Provider]    │
└─────────────────────────┘
```

**Что это даёт:** Весь main content area — для билд-панели. Не нужно делить экран с чат-сайдбаром. Логично: в build mode ты редактируешь персонажа, а не выбираешь чаты.

---

## 2. World & Logic — основная панель

### Шаг 1: Выбор типа (Lorebooks или Scripts)

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                      │
│                                                                      │
│     ┌─────────────────┐     ┌─────────────────┐                    │
│     │                  │     │                  │                    │
│     │   📚 Lorebooks   │     │  🎲 Scripts      │                    │
│     │                  │     │                  │                    │
│     │  World info,     │     │  JS code that    │                    │
│     │  lore entries,   │     │  runs on every   │                    │
│     │  knowledge base  │     │  message turn    │                    │
│     │                  │     │                  │                    │
│     └─────────────────┘     └─────────────────┘                    │
│                                                                      │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Шаг 2: После клика — анимация

Клик на "Lorebooks" → карточка расширяется к верху, превращается в заголовок:

```
┌─────────────────────────────────────────────────────────────────────┐
│  ← back    📚 Lorebooks                            [+ New Lorebook] │
├──────────┬──────────────────────────────────────────────────────────┤
│           │                                                          │
│  🌐 Global│                                                          │
│           │   ┌─ Lorebook: Main Lore ──────────────────────────┐    │
│  📖 Char  │   │  ▼ (expanded)                         3 entries │    │
│     ●     │   │                                                   │    │
│  👤 Persona│   │  ┌──────────────────────────────────────────┐   │    │
│           │   │  │ ☑ Tidal Wraiths                          │   │    │
│  💬 Chat  │   │  │ keys: wraith, tide, shadow               │   │    │
│           │   │  │ pos: in_prompt · depth: 4                │   │    │
│           │   │  │ Tidal wraiths are shadowy entities that...│   │    │
│           │   │  └──────────────────────────────────────────┘   │    │
│           │   │                                                   │    │
│           │   │  ┌──────────────────────────────────────────┐   │    │
│           │   │  │ ☑ Ashmore Lighthouse                     │   │    │
│           │   │  │ keys: lighthouse + ashmore               │   │    │
│           │   │  │ pos: after_char · depth: 0               │   │    │
│           │   │  │ Built in 1983, deactivated after...      │   │    │
│           │   │  └──────────────────────────────────────────┘   │    │
│           │   │                                                   │    │
│           │   │  ┌──────────────────────────────────────────┐   │    │
│           │   │  │ ☐ Barrier Stones                    OFF  │   │    │
│           │   │  │ keys: stone, glyph, barrier              │   │    │
│           │   │  │ pos: before_char · depth: 2              │   │    │
│           │   │  │ Ancient markers inscribed with...         │   │    │
│           │   │  └──────────────────────────────────────────┘   │    │
│           │   └───────────────────────────────────────────────────┘    │
│           │                                                          │
│           │   ┌─ Lorebook: Combat Mechanics ────────────────────┐    │
│           │   │  ▶ (collapsed)                          2 entries │    │
│           │   └───────────────────────────────────────────────────┘    │
│           │                                                          │
│           │   [+ Import Lorebook]                                    │
│           │                                                          │
│           │   📊 5 entries · ~380 tokens · Budget: 1000             │
│           │                                                          │
└──────────┴──────────────────────────────────────────────────────────┘
```

### Scope-табы — вертикально слева

```
┌──────┐
│ 🌐   │  ← Global (навсегда привязан к платформе)
│      │
│ 📖   │  ← Character (привязан к текущему персонажу)
│  ●   │     точка = активный scope
│ 👤   │  ← Persona (привязан к активной персоне)
│      │
│ 💬   │  ← Chat (только этот чат)
└──────┘
```

Иконки с тултипами. Тонкая вертикальная полоска, ~48px. При hover — название scope.

---

## 3. Entry Editor — после клика на карточку entry

Карточка кликается → открывается редактор на всю ширину (под scope-колонкой).

### Simple Mode (по умолчанию)

```
┌─────────────────────────────────────────────────────────────────────┐
│  ← back to entries    Tidal Wraiths                    [ON] [🗑]  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Keys                                                                │
│  [wraith ×] [tide ×] [shadow ×]    [+ add keyword]                 │
│                                                                      │
│  Content                                                             │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ Tidal wraiths are shadowy entities that appear when the      │   │
│  │ tide is low. They cannot cross barrier stones.               │   │
│  │                                                               │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ── Test ──                                                          │
│  [I saw a wraith by the tide     ] [Test]                           │
│  ✅ HIT — matched "wraith", "tide"                                   │
│                                                                      │
│  [Show Advanced Settings ▼]                                          │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

Simple mode = только keys + content + тест. Всё что нужно для 80% entries.

### Advanced Mode (раскрытый)

```
┌─────────────────────────────────────────────────────────────────────┐
│  ← back to entries    Tidal Wraiths                    [ON] [🗑]  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Keys                                                                │
│  [wraith ×] [tide ×] [shadow ×]    [+ add keyword]                 │
│                                                                      │
│  Secondary Keys                                                      │
│  [night ×]                          [+ add keyword]                  │
│                                                                      │
│  Content                                                             │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ Tidal wraiths are shadowy entities that appear when the      │   │
│  │ tide is low. They cannot cross barrier stones.               │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ── Advanced ────────────────────────────────────────────────────    │
│                                                                      │
│  Logic        [AND ANY ▼]          Position    [in_prompt ▼]       │
│  Depth        [4]                  Priority    [10]                 │
│  Sticky       [0] msgs             Cooldown    [0] msgs            │
│  Delay        [0] msgs             Constant    [OFF]               │
│  Token Budget [∞]                  Group       [____________]      │
│                                                                      │
│  ── Test ──                                                          │
│  [I saw a wraith by the tide     ] [Test]                           │
│  ✅ HIT — matched "wraith", "tide"                                   │
│                                                                      │
│  [Hide Advanced Settings ▲]                                          │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

**Toggle:** Кнопка "Show Advanced" / "Hide Advanced". Состояние запоминается в UI settings — если юзер один раз раскрыл, для новых entries тоже показывает advanced.

---

## 4. Scripts — та же структура, другой контент

### Список скриптов (после клика на "Scripts" на шаге 1)

```
┌─────────────────────────────────────────────────────────────────────┐
│  ← back    🎲 Scripts                                [+ New Script] │
├──────────┬──────────────────────────────────────────────────────────┤
│           │                                                          │
│  🌐 Global│                                                          │
│           │   ┌─ Script Card ───────────────────────────────────┐    │
│  📖 Char  │   │                                                │    │
│     ●     │   │  🎲 Gacha Summon System                [ON]    │    │
│  👤 Persona│   │  hook: before_prompt · scope: character        │    │
│           │   │                                                │    │
│  💬 Chat  │   │  var msg = context.chat.last_message;           │    │
│           │   │  if (msg.includes("summon")) {                  │    │
│           │   │    var result = rollSummon(msg);                │    │
│           │   │    context.inject.add_to_personality(           │    │
│           │   │      buildInjection(result)                     │    │
│           │   │    );                                           │    │
│           │   │  }                                              │    │
│           │   │                                                │    │
│           │   │  [Edit]  [Test ▶]  [Duplicate]  [🗑]           │    │
│           │   └────────────────────────────────────────────────┘    │
│           │                                                          │
│           │   ┌─ Script Card ───────────────────────────────────┐    │
│           │   │  🧙 Mana Tracker                         [ON]    │    │
│           │   │  hook: before_prompt · scope: chat              │    │
│           │   │  var mana = context.state.get("mana") || 100;   │    │
│           │   │  ...                                              │    │
│           │   │  [Edit]  [Test ▶]  [Duplicate]  [🗑]            │    │
│           │   └────────────────────────────────────────────────┘    │
│           │                                                          │
│           │   [+ Import from Janitor]                                │
│           │                                                          │
└──────────┴──────────────────────────────────────────────────────────┘
```

### Script Editor (после клика Edit)

```
┌─────────────────────────────────────────────────────────────────────┐
│  ← back to scripts    Gacha Summon System             [ON] [🗑]   │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Name [Gacha Summon System          ]                                │
│  Hook [before_prompt ▼]    Scope [character ▼]                     │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  1 │ var msg = context.chat.last_message;                    │   │
│  │  2 │ var normalized = msg.toLowerCase();                     │   │
│  │  3 │                                                          │   │
│  │  4 │ if (normalized.includes("summon")) {                    │   │
│  │  5 │   var pool = detectPool(normalized);                    │   │
│  │  6 │   var banner = detectBanner(normalized);                │   │
│  │  7 │   var result = rollSummon(pool, banner);                │   │
│  │  8 │   context.inject.add_to_personality(                    │   │
│  │  9 │     buildInjection(pool, banner, result)                │   │
│  │ 10 │   );                                                     │   │
│  │ 11 │ }                                                        │   │
│  │ 12 │                                                          │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ── Test Console ────────────────────────────────────────────────    │
│  Test message:                                                       │
│  [Male Legendary Summon            ] [▶ Run]                        │
│                                                                      │
│  Output:                                                             │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ [SUMMON RESULT]                                              │   │
│  │ Pool: male. Banner: legendary.                               │   │
│  │ Rolled rarity: ssr.                                          │   │
│  │ Selected: Lord Valerius (unique).                            │   │
│  │ Injecting into personality: +312 tokens.                     │   │
│  │ [/SUMMON RESULT]                                             │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  State after run: { "summon_count": 1, "last_banner": "legendary" } │
│                                                                      │
│  📖 API Reference                                          [Docs ▼] │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ context.chat.last_message  — string, last user message       │   │
│  │ context.character.name     — string                          │   │
│  │ context.inject.add_to_personality(text) — inject text        │   │
│  │ context.state.get(key)     — read persisted state            │   │
│  │ context.state.set(key, v)  — write persisted state           │   │
│  │ ...                                                          │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 5. Мобильная версия

### Drill-down flow

```
Step 1: Build Sections         Step 2: World & Logic       Step 3: Lorebooks
┌──────────────────┐          ┌──────────────────┐        ┌──────────────────┐
│ ← Back to Chat   │          │ ← Back           │        │ ← Lorebooks     │
│                  │          │                  │        │                  │
│ 📝 Character     │          │ ┌──────────────┐│        │ 🌐 📖 👤 💬     │
│ 📚 World & Logic │  ──►    │ │ 📚 Lorebooks ││  ──►  │ (scope tabs     │
│ 🔍 Trace         │          │ │              ││        │  горизонтально) │
│ 🔧 Tools         │          │ │ 🎲 Scripts   ││        │                  │
│                  │          │ └──────────────┘│        │ ▼ Main Lore     │
│                  │          │                  │        │   Tidal Wraiths │
│                  │          │                  │        │   Ashmore Light │
│                  │          │                  │        │   Barrier Stones│
│                  │          │                  │        │                  │
└──────────────────┘          └──────────────────┘        └──────────────────┘

Step 4: Entry Editor
┌──────────────────┐
│ ← Entries        │
│                  │
│ Tidal Wraiths    │
│ [ON]             │
│                  │
│ Keys:            │
│ [wraith×][tide×] │
│                  │
│ Content:         │
│ ┌──────────────┐│
│ │ Tidal wraiths││
│ │ are shadowy..││
│ └──────────────┘│
│                  │
│ [Advanced ▼]     │
│                  │
│ Test:            │
│ [msg..    ] [Go] │
│ ✅ HIT           │
└──────────────────┘
```

---

## 6. Навигационный flow — итоговая карта

```
Build Mode
  │
  ├─ Sidebar: секции билда
  │    ├─ Character Form
  │    ├─ World & Logic  ←── выбор этой секции
  │    ├─ Prompt Trace
  │    └─ Tools
  │
  └─ Main Content:
       │
       ├─ Шаг 0: [Lorebooks] [Scripts]     ← две карточки
       │      │
       │      ├─→ Lorebooks:
       │      │    ├─ Scope bar (вертикально): Global | Char | Persona | Chat
       │      │    ├─ Lorebook Accordions (горизонтальные)
       │      │    │    └─ Entry Cards (с превью)
       │      │    │         └─ Entry Editor (simple / advanced)
       │      │    └─ Footer: stats
       │      │
       │      └─→ Scripts:
       │           ├─ Scope bar (вертикально)
       │           ├─ Script Cards (с превью кода)
       │           │    └─ Script Editor + Test Console
       │           └─ Footer: stats
       │
       └─ Back-кнопка всегда возвращает на шаг назад
```

---

## 7. Анимация перехода Tab → Header

```
Начальное состояние:          После клика на "Lorebooks":
                              
┌───────────────────────┐     ┌───────────────────────────────┐
│                       │     │ ← back    📚 Lorebooks        │
│   ┌────────┐┌────────┐│     │                               │
│   │📚 Lore ││🎲 Script││     │  (контент lorebooks)          │
│   └────────┘└────────┘│     │                               │
│                       │     │                               │
└───────────────────────┘     └───────────────────────────────┘

Анимация:
1. Cards scale down до размера таба
2. Scripts card fade out + slide right
3. Lorebooks card expands to full width
4. Morphs into header bar
5. Content fades in below
```
