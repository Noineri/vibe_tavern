#!/usr/bin/env python3
"""bun:test → vitest codemod for apps/web test files.

Mechanical transformations (category A — covers ~70% of files end-to-end):
  1. mock.module(         → vi.mock(
  2. mock.restore/clear/  → vi.restoreAllMocks / vi.clearAllMocks / vi.resetAllMocks
     reset()
  3. bare mock(           → vi.fn(   (skips `.mock(` / `vi.mock(`)
  4. import { …, mock, … } from "bun:test" → from "vitest"; drop `mock`, add `vi`
     when the file now uses vi.*
  5. drop `useDomEnv` import + call (vitest happy-dom env owns the DOM)
  6. drop direct `GlobalRegistrator` import + register/unregister calls

Does NOT handle (surfaced by `vitest run` failures, fix by hand):
  - category B:  const r = await import(p); mock.module(p, () => ({...r,...}))
    → vi.mock(p, async (importOriginal) => ({ ...(await importOriginal()), ...}))
    (vi.mock is hoisted; the outer `r` is undefined at factory-call time)
  - category C:  const X = …; mock.module(p, () => ({ f: () => X }))
    → move X into vi.hoisted(() => ({ X: … }))  (same hoisting reason)
Both leave the mock silently un-applied → test fails loudly → fix manually.
"""
import re
import sys

VI_METHODS = re.compile(
    r"\bvi\.(mock|fn|hoisted|spyOn|restoreAllMocks|clearAllMocks|"
    r"resetAllMocks|stubGlobal|useFakeTimers)\b"
)


def codemod(src: str) -> str:
    # 1–3: body rewrites first, so vi.mock(/vi.fn( exist before the import rewrite
    src = re.sub(r"\bmock\.module\(", "vi.mock(", src)
    src = re.sub(r"\bmock\.restore\(\)", "vi.restoreAllMocks()", src)
    src = re.sub(r"\bmock\.clear\(\)", "vi.clearAllMocks()", src)
    src = re.sub(r"\bmock\.reset\(\)", "vi.resetAllMocks()", src)
    # bare mock( → vi.fn(  (negative lookbehind: not after . or word char)
    src = re.sub(r"(?<![.\w])mock\(", "vi.fn(", src)

    # 4: rewrite the bun:test import line
    def fix_import(m: re.Match) -> str:
        inner = m.group(1)
        parts = [p.strip() for p in inner.split(",") if p.strip()]
        parts = [p for p in parts if p != "mock"]
        if VI_METHODS.search(src) and "vi" not in parts:
            parts.append("vi")
        return 'import { ' + ", ".join(parts) + ' } from "vitest"'

    src = re.sub(r'import \{ ([^}]+) \} from "bun:test"', fix_import, src)

    # 5: useDomEnv
    src = re.sub(r'import \{ useDomEnv \} from "[^"]*dom-env\.js";\r?\n', "", src)
    src = re.sub(r"^[ \t]*useDomEnv\(\);[ \t]*\r?\n", "", src, flags=re.MULTILINE)

    # 6: direct GlobalRegistrator users (message-block-isolation pattern)
    src = re.sub(
        r'import \{ GlobalRegistrator \} from "@happy-dom/global-registrator";\r?\n',
        "", src,
    )
    src = re.sub(r"^[ \t]*GlobalRegistrator\.register\(\);[ \t]*\r?\n", "", src, flags=re.MULTILINE)
    src = re.sub(r"^[ \t]*GlobalRegistrator\.unregister\(\);[ \t]*\r?\n", "", src, flags=re.MULTILINE)

    return src


def main() -> None:
    path = sys.argv[1]
    with open(path, "r", encoding="utf-8", newline="") as f:
        src = f.read()
    new = codemod(src)
    if new != src:
        with open(path, "w", encoding="utf-8", newline="") as f:
            f.write(new)
        print(f"modified: {path}")


if __name__ == "__main__":
    main()
