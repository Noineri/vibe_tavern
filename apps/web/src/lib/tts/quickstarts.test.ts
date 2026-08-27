import { describe, expect, test } from "bun:test";

import { diagnosticI18nKey, LOCAL_TTS_QUICKSTARTS, worstDiagnostic } from "./quickstarts.js";
import type { DiscoveryDiagnosticCode } from "./server-discovery.js";

describe("quickstarts", () => {
  test("has exactly two entries with verified shape", () => {
    expect(LOCAL_TTS_QUICKSTARTS.length).toBe(2);
    const ids = LOCAL_TTS_QUICKSTARTS.map((q) => q.id);
    expect(new Set(ids).size).toBe(2);
    const kokoro = LOCAL_TTS_QUICKSTARTS.find((q) => q.id === "kokoro-fastapi");
    expect(kokoro).toBeDefined();
    expect(kokoro?.port).toBe(8880);
    expect(kokoro?.endpoint).toBe("http://127.0.0.1:8880/v1");
    expect(kokoro?.command.length).toBeGreaterThan(0);
    expect(kokoro?.command).toContain("ghcr.io/remsky/kokoro-fastapi-cpu:latest");
    const edge = LOCAL_TTS_QUICKSTARTS.find((q) => q.id === "openai-edge-tts");
    expect(edge).toBeDefined();
    expect(edge?.port).toBe(5050);
    expect(edge?.endpoint).toBe("http://127.0.0.1:5050/v1");
    expect(edge?.command.length).toBeGreaterThan(0);
    expect(edge?.command).toContain("travisvn/openai-edge-tts:latest");
    for (const q of LOCAL_TTS_QUICKSTARTS) {
      expect(q.name.length).toBeGreaterThan(0);
      expect(q.endpoint.endsWith("/v1")).toBe(true);
      expect(q.endpoint.startsWith("http://127.0.0.1:")).toBe(true);
    }
  });

  test("every quickstart carries a non-docker launch variant (D8 honesty)", () => {
    // Verified against the upstream READMEs (2026-08-27): remsky/Kokoro-FastAPI
    // runs directly via uv start scripts; travisvn/openai-edge-tts via venv +
    // pip + python app/server.py. A card without an alt command would silently
    // assume docker again — exactly the defect D8 fixed.
    for (const q of LOCAL_TTS_QUICKSTARTS) {
      expect(q.alt.command.length).toBeGreaterThan(0);
      expect(q.alt.command).not.toContain("docker run");
      expect(q.alt.noteKey.length).toBeGreaterThan(0);
    }
    const kokoro = LOCAL_TTS_QUICKSTARTS.find((q) => q.id === "kokoro-fastapi");
    expect(kokoro?.alt.command).toContain("start-cpu");
    const edge = LOCAL_TTS_QUICKSTARTS.find((q) => q.id === "openai-edge-tts");
    expect(edge?.alt.command).toContain("app/server.py");
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
