# Lorebook & Scripts Panel — UI Variants

> Все варианты — вкладка внутри Build Mode. Название вкладки: **"World & Logic"** (или "Lore & Scripts", или как захочешь).

---

## Вариант A: Классический master-detail (3 колонки)

Два таба сверху: Lorebooks / Scripts. Внутри Lorebooks — три колонки.

```
┌─────────────────────────────────────────────────────────────────────┐
│  [Character]  [World & Logic]  [Trace]  [Tools]                    │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ── Lorebooks ─────────────── ── Scripts ──                          │
│                                                                      │
│  ┌─ Lorebooks ────┐ ┌─ Entries ────────┐ ┌─ Editor ──────────────┐ │
│  │                 │ │                  │ │                        │ │
│  │ ▼ 🌐 Global     │ │ ☑ Tidal Wraiths │ │ Title                  │ │
│  │   └ (1 entry)  │ │ ☑ Ashmore Light │ │ [Tidal Wraiths    ]   │ │
│  │                 │ │ ☐ Barrier Stones│ │                        │ │
│  │ ▶ 📖 Characters│ │                  │ │ Enabled  [ON]         │ │
│  │                 │ │ 🔍 search...     │ │                        │ │
│  │ ▶ 👤 Personas  │ │                  │ │ Keys                   │ │
│  │                 │ │ [+ Add] [Import] │ │ [wraith ×][tide ×]   │ │
│  │ ▶ 💬 This Chat │ │                  │ │ [_______________]     │ │
│  │                 │ │                  │ │                        │ │
│  │                 │ │                  │ │ Logic  [AND ANY ▼]    │ │
│  │                 │ │                  │ │ Pos    [in_prompt ▼]  │ │
│  │                 │ │                  │ │ Depth  [4]  Prio [10] │ │
│  │                 │ │                  │ │                        │ │
│  │ [+ New Lorebook]│ │                  │ │ ┌──────────────────┐  │ │
│  │                 │ │                  │ │ │ Content           │  │ │
│  │                 │ │                  │ │ │ Tidal wraiths are │  │ │
│  │                 │ │                  │ │ │ shadowy entities  │  │ │
│  │                 │ │                  │ │ │ ...               │  │ │
│  │                 │ │                  │ │ └──────────────────┘  │ │
│  │                 │ │                  │ │                        │ │
│  │                 │ │                  │ │ ── Test ──             │ │
│  │                 │ │                  │ │ [message...    ] [Go] │ │
│  │                 │ │                  │ │ ✅ HIT                │ │
│  └─────────────────┘ └──────────────────┘ └────────────────────────┘ │
│                                                                      │
│  📊 3 entries · ~245 tokens · Budget: 1000                          │
└─────────────────────────────────────────────────────────────────────┘
```

Плюсы:
- Видно всё сразу — lorebook → entries → конкретная entry
- Быстрая навигация между scope
- Привычный patern (как VS Code explorer)

Минусы:
- Три колонки тесно на экранах <1400px
- Много горизонтального скролла
- Scripts — отдельный таб, теряется контекст

---

## Вариант B: Двухколоночный с scope-табами сверху

Один таб "Lore & Scripts". Слева — список всего (лорбуки + скрипты вперемешку), справа — редактор. Scope — табы сверху.

```
┌─────────────────────────────────────────────────────────────────────┐
│  [Character]  [World & Logic]  [Trace]  [Tools]                    │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  [📖 Character] [👤 Persona] [💬 Chat] [🌐 Global]                 │
│                                                                      │
│  ┌─ Items ────────────────┐ ┌─ Editor ──────────────────────────┐  │
│  │                        │ │                                    │  │
│  │  📚 Lorebook: Main     │ │  [Lore Entry]  [Script]  ← type   │  │
│  │    ☑ Tidal Wraiths     │ │                                    │  │
│  │    ☑ Ashmore Lighthouse│ │  Title: [Tidal Wraiths        ]   │  │
│  │    ☐ Barrier Stones    │ │  Enabled: [ON]                     │  │
│  │                        │ │                                    │  │
│  │  📚 Lorebook: Combat   │ │  Keys: [wraith ×][tide ×]        │  │
│  │    ☑ Weapon Types      │ │  Sec:  [shadow ×]                  │  │
│  │    ☑ Armor Classes     │ │                                    │  │
│  │                        │ │  Logic [AND ANY ▼]  Pos [▼]       │  │
│  │  ── Scripts ──         │ │  Depth [4]  Priority [10]         │  │
│  │  🎲 Gacha Summon       │ │                                    │  │
│  │  🧙 Mana System        │ │  ┌──────────────────────────────┐ │  │
│  │                        │ │  │ Content                       │ │  │
│  │                        │ │  │ Tidal wraiths are shadowy     │ │  │
│  │                        │ │  │ entities that appear when...  │ │  │
│  │  [+ Entry] [Import]    │ │  └──────────────────────────────┘ │  │
│  │  [+ Script]            │ │                                    │  │
│  │  🔍 search...          │ │  ── Activation Test ──             │  │
│  │                        │ │  [test message...    ] [Test]      │  │
│  │                        │ │  ✅ HIT (in_prompt, depth 4)       │  │
│  └────────────────────────┘ └────────────────────────────────────┘  │
│                                                                      │
│  3 lorebooks · 7 entries · 2 scripts · ~245 lore tokens             │
└─────────────────────────────────────────────────────────────────────┘
```

Плюсы:
- Лорбуки и скрипты видны **вместе** — один список
- Двухколоночный = комфортно на 1200px+
- Scope-табы фильтруют что показывать
- Редактор entry и скрипта — одна правая панель, тип переключается

Минусы:
- Список может стать длинным (много entries = много скролла)
- Лорбуки визуально сливаются со скриптами
- Нет быстрого перехода между entries одного lorebook

---

## Вариант C: Карточный — всё на одной поверхности

Нет колонок. Scope и тип — фильтры сверху. Entries — карточки в гриде/списке. Клик — раскрывает inline-editor.

```
┌─────────────────────────────────────────────────────────────────────┐
│  [Character]  [World & Logic]  [Trace]  [Tools]                    │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Scope: [📖 Char ▼]   Type: [All ▼]   🔍 search...   [+ Add]      │
│                                                                      │
│  ┌─────────────────────────┐ ┌─────────────────────────┐           │
│  │ ☑ Tidal Wraiths         │ │ ☑ Ashmore Lighthouse     │           │
│  │ keys: wraith, tide, sha │ │ keys: lighthouse, tower  │           │
│  │ pos: in_prompt · d:4    │ │ + ashmore                │           │
│  │                         │ │ pos: after_char · d:0    │           │
│  │ [Edit] [Test] [Dup] [🗑]│ │ logic: AND_ALL           │           │
│  └─────────────────────────┘ │                          │           │
│                              │ [Edit] [Test] [Dup] [🗑] │           │
│  ┌─────────────────────────┐ └─────────────────────────┘           │
│  │ ☐ Barrier Stones        │                                       │
│  │ keys: stone, glyph, bar │ ┌─────────────────────────┐           │
│  │ pos: before_char · d:2  │ │ 🎲 Gacha Summon          │           │
│  │ ⚠ DISABLED              │ │ scope: character          │           │
│  │                         │ │ hook: before_prompt       │           │
│  │ [Edit] [Test] [Dup] [🗑]│ │                           │           │
│  └─────────────────────────┘ │ [Edit] [Test] [Run] [🗑]  │           │
│                              └─────────────────────────┘           │
│                                                                      │
│  (кнопка Edit → раскрывает карточку на весь экран или drawer)       │
│                                                                      │
│  3 entries · 1 script · ~245 tokens                                 │
└─────────────────────────────────────────────────────────────────────┘
```

Плюсы:
- Всё видно сразу, никакого drilling
- Лор-энтри и скрипты рядом — наглядно
- Масштабируется — карточки можно в любом порядке

Минусы:
- Редактирование — отдельный шаг (drawer/modal), не видно список
- Нет иерархии lorebook → entries
- Не видно принадлежность к конкретному lorebook

---

## Вариант D: Sidebar drill-down (как настройки Telegram/Figma)

Один вертикальный список. Клик на lorebook → раскрывает его entries. Клик на entry → раскрывает editor, сдвигая список.

```
┌─────────────────────────────────────────────────────────────────────┐
│  [Character]  [World & Logic]  [Trace]  [Tools]                    │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌─ Navigator ──────────────────────────────────────────────────┐   │
│  │                                                               │   │
│  │  🌐 Global                                                    │   │
│  │  📖 Character Lore                                            │   │
│  │    └ ▼ Lorebook: Main (3 entries)                            │   │
│  │       ☑ Tidal Wraiths             ← клик = редактировать     │   │
│  │       ☑ Ashmore Lighthouse                                   │   │
│  │       ☐ Barrier Stones                                       │   │
│  │    └ ▶ Lorebook: Combat (2 entries)                          │   │
│  │  👤 Persona Lore                                              │   │
│  │  💬 Chat Lore                                                 │   │
│  │  ─────────────                                               │   │
│  │  🎲 Scripts                                                   │   │
│  │    └ ☑ Gacha Summon                                           │   │
│  │    └ ☑ Mana System                                            │   │
│  │                                                               │   │
│  │  [+ Lorebook] [+ Entry] [+ Script] [Import]                  │   │
│  └───────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌─ Editor (появляется при выборе) ──────────────────────────────┐  │
│  │                                                                │  │
│  │  Tidal Wraiths                                    [ON] [🗑]  │  │
│  │                                                                │  │
│  │  Keys: [wraith ×] [tide ×] [shadow ×]  [+ add]              │  │
│  │  Sec:  (none)                        [+ add]                  │  │
│  │                                                                │  │
│  │  Logic: AND ANY | Position: in_prompt | Depth: 4 | Prio: 10  │  │
│  │                                                                │  │
│  │  ┌────────────────────────────────────────────────────────┐  │  │
│  │  │ Tidal wraiths are shadowy entities that appear when    │  │  │
│  │  │ the tide is low. They cannot cross barrier stones.     │  │  │
│  │  └────────────────────────────────────────────────────────┘  │  │
│  │                                                                │  │
│  │  Test: [I saw a wraith in the tide] [Test]                    │  │
│  │  ✅ HIT — matches "wraith", "tide" (AND_ANY)                  │  │
│  │                                                                │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

Плюсы:
- Единое дерево — видна вся структуру мира
- Scripts встроены в тот же навигатор
- Editor занимает всю ширину — просторно
- Хорошо работает на узких экранах

Минусы:
- Дерево может быть глубоким (scope → lorebook → entry → editor)
- Две зоны (список + editor) могут спорить за высоту
- Нет одновременного просмотра entry list + editor

---

## Мобильная версия (общая для всех)

На мобилке — drill-down: список → редактор (fullscreen с back-кнопкой). Это уже реализовано в текущем LorebookEditor.tsx, паттерн тот же.

---

## Мой совет

Если бы я выбирал — **Вариант D** с элементами B:

- Навигатор слева — дерево (scope → lorebook → entries + scripts)
- Editor справа — на всю оставшуюся ширину
- Табы scope не нужны — всё видно в дереве
- Скрипты — в том же дереве, отдельная секция

Но это моё мнение — тебе смотреть и решать. Что визуально ближе к тому, что ты хочешь?
