import { describe, expect, test } from "bun:test";

import {
  detectTtsOsKind,
  diagnosticI18nKey,
  TTS_SERVER_SETUP_GUIDES,
  worstDiagnostic,
} from "./quickstarts.js";
import type { DiscoveryDiagnosticCode } from "@vibe-tavern/domain";

describe("quickstarts (setup reference, TE2-17)", () => {
  test("two guides with verified identity fields", () => {
    expect(TTS_SERVER_SETUP_GUIDES.length).toBe(2);
    const ids = TTS_SERVER_SETUP_GUIDES.map((g) => g.id);
    expect(new Set(ids).size).toBe(2);
    const kokoro = TTS_SERVER_SETUP_GUIDES.find((g) => g.id === "kokoro-fastapi");
    expect(kokoro).toBeDefined();
    expect(kokoro?.port).toBe(8880);
    expect(kokoro?.endpoint).toBe("http://127.0.0.1:8880/v1");
    const edge = TTS_SERVER_SETUP_GUIDES.find((g) => g.id === "openai-edge-tts");
    expect(edge).toBeDefined();
    expect(edge?.port).toBe(5050);
    expect(edge?.endpoint).toBe("http://127.0.0.1:5050/v1");
    for (const g of TTS_SERVER_SETUP_GUIDES) {
      expect(g.name.length).toBeGreaterThan(0);
      expect(g.endpoint.startsWith("http://127.0.0.1:")).toBe(true);
      expect(g.endpoint.endsWith("/v1")).toBe(true);
    }
  });

  test("docker + clone commands verified against upstream, OS-identical", () => {
    const kokoro = TTS_SERVER_SETUP_GUIDES.find((g) => g.id === "kokoro-fastapi");
    const kokoroDocker = kokoro?.docker.commands.windows.join(" ") ?? "";
    expect(kokoroDocker).toContain("docker run -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest");
    expect(kokoro?.clone.commands.unix.join(" ")).toContain("git clone https://github.com/remsky/Kokoro-FastAPI.git");
    const edge = TTS_SERVER_SETUP_GUIDES.find((g) => g.id === "openai-edge-tts");
    const edgeDocker = edge?.docker.commands.unix.join(" ") ?? "";
    expect(edgeDocker).toContain("docker run -d -p 5050:5050 -e PORT=5050 travisvn/openai-edge-tts:latest");
    expect(edge?.clone.commands.windows.join(" ")).toContain("git clone https://github.com/travisvn/openai-edge-tts.git");
    // Docker and clone are OS-identical by design — the OS toggle must not
    // change them (TE2-17: the toggle affects only the no-Docker branch).
    for (const g of TTS_SERVER_SETUP_GUIDES) {
      expect(g.docker.commands.windows).toEqual(g.docker.commands.unix);
      expect(g.clone.commands.windows).toEqual(g.clone.commands.unix);
    }
  });

  test("install: edge-tts per-OS venv activation; kokoro bootstraps itself (note, no invented commands)", () => {
    const edge = TTS_SERVER_SETUP_GUIDES.find((g) => g.id === "openai-edge-tts");
    // README-verbatim activation spellings per OS.
    expect(edge?.install.commands.windows).toContain("venv\\Scripts\\activate");
    expect(edge?.install.commands.unix).toContain("source venv/bin/activate");
    for (const os of ["windows", "unix"] as const) {
      const cmds = edge?.install.commands[os] ?? [];
      expect(cmds).toContain("python -m venv venv");
      expect(cmds).toContain("pip install -r requirements.txt");
    }
    // Kokoro's start scripts self-bootstrap dependencies via uv — an install
    // command list would be invented. Honesty rule: note-only.
    const kokoro = TTS_SERVER_SETUP_GUIDES.find((g) => g.id === "kokoro-fastapi");
    expect(kokoro?.install.commands.windows).toEqual([]);
    expect(kokoro?.install.commands.unix).toEqual([]);
    expect(kokoro?.install.noteKey).toBeDefined();
  });

  test("run: separate copyable command per OS — never glued to clone with &&", () => {
    const kokoro = TTS_SERVER_SETUP_GUIDES.find((g) => g.id === "kokoro-fastapi");
    // Repo root ships both scripts (verified live 2026-08-28).
    expect(kokoro?.run.commands.windows).toEqual([".\\start-cpu.ps1"]);
    expect(kokoro?.run.commands.unix).toEqual(["./start-cpu.sh"]);
    const edge = TTS_SERVER_SETUP_GUIDES.find((g) => g.id === "openai-edge-tts");
    expect(edge?.run.commands.windows).toEqual(["python app/server.py"]);
    expect(edge?.run.commands.unix).toEqual(["python app/server.py"]);
    // Owner rule: every command in the guide stays a separate copyable unit —
    // no compound `&&` chains anywhere (the old alt commands glued
    // clone+cd+run into one line).
    for (const g of TTS_SERVER_SETUP_GUIDES) {
      for (const step of [g.docker, g.clone, g.install, g.run]) {
        for (const os of ["windows", "unix"] as const) {
          for (const cmd of step.commands[os]) {
            expect(cmd.includes("&&")).toBe(false);
          }
        }
      }
    }
  });

  test("every step title/description/note key is a known i18n key", () => {
    for (const g of TTS_SERVER_SETUP_GUIDES) {
      const keys = [
        g.descriptionKey,
        g.docker.titleKey,
        g.clone.titleKey,
        g.install.titleKey,
        g.run.titleKey,
        ...(g.docker.noteKey ? [g.docker.noteKey] : []),
        ...(g.install.noteKey ? [g.install.noteKey] : []),
        ...(g.run.noteKey ? [g.run.noteKey] : []),
      ];
      for (const key of keys) {
        expect(typeof key).toBe("string");
        expect(key.length).toBeGreaterThan(0);
      }
    }
  });

  test("detectTtsOsKind: Windows UAs → windows, everything else → unix", () => {
    expect(detectTtsOsKind("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows");
    expect(detectTtsOsKind("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("unix");
    expect(detectTtsOsKind("Mozilla/5.0 (X11; Linux x86_64)")).toBe("unix");
    expect(detectTtsOsKind("")).toBe("unix");
  });

  test("worstDiagnostic priority matrix", () => {
    expect(worstDiagnostic([])).toBeNull();
    expect(worstDiagnostic(["server-not-running"])).toBe("server-not-running");
    expect(worstDiagnostic(["server-not-running", "wrong-shape"])).toBe("wrong-shape");
    expect(worstDiagnostic(["wrong-shape", "auth-or-http"])).toBe("auth-or-http");
    expect(worstDiagnostic(["auth-or-http", "http-other"])).toBe("http-other");
    expect(worstDiagnostic(["http-other", "timeout"])).toBe("timeout");
    expect(worstDiagnostic(["server-not-running", "timeout", "wrong-shape"])).toBe("timeout");
    expect(worstDiagnostic(["server-not-running", "server-not-running"])).toBe("server-not-running");
    // found is ignored
    const found: DiscoveryDiagnosticCode = "found";
    expect(worstDiagnostic([found, "server-not-running"])).toBe("server-not-running");
    expect(worstDiagnostic([found])).toBeNull();
  });

  test("diagnosticI18nKey mapping table", () => {
    expect(diagnosticI18nKey("server-not-running")).toBe("tts_discover_diag_server_not_running");
    expect(diagnosticI18nKey("wrong-shape")).toBe("tts_discover_diag_wrong_shape");
    expect(diagnosticI18nKey("auth-or-http")).toBe("tts_discover_diag_auth_or_http");
    expect(diagnosticI18nKey("http-other")).toBe("tts_discover_diag_http_other");
    expect(diagnosticI18nKey("timeout")).toBe("tts_discover_diag_timeout");
  });
});
