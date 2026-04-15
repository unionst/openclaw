import type { StreamFn } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  createVercelAiGatewayAnthropicFastModeWrapper,
  resolveVercelAiGatewayFastMode,
  wrapVercelAiGatewayProviderStream,
} from "./stream-wrappers.js";

const FAST_MODE_BETA = "fast-mode-2026-02-01";

type Captured = {
  headers?: Record<string, string>;
  payload?: Record<string, unknown>;
};

function buildBaseStreamFn(captured: Captured): StreamFn {
  return (model, _context, options) => {
    captured.headers = options?.headers;
    if (options?.onPayload) {
      const payload: Record<string, unknown> = {};
      options.onPayload(payload, model);
      captured.payload = payload;
    }
    return {} as never;
  };
}

function runFastModeWrapper(params: {
  enabled?: boolean;
  modelId?: string;
  modelApi?: string;
  existingHeaders?: Record<string, string>;
  existingPayload?: Record<string, unknown>;
}): Captured {
  const captured: Captured = {};
  const base: StreamFn = (model, _context, options) => {
    captured.headers = options?.headers;
    const payload: Record<string, unknown> = { ...params.existingPayload };
    options?.onPayload?.(payload as never, model);
    captured.payload = payload;
    return {} as never;
  };
  const wrapper = createVercelAiGatewayAnthropicFastModeWrapper(base, params.enabled ?? true);
  void wrapper(
    {
      provider: "vercel-ai-gateway",
      api: params.modelApi ?? "anthropic-messages",
      id: params.modelId ?? "anthropic/claude-opus-4.6",
    } as never,
    {} as never,
    { headers: params.existingHeaders } as never,
  );
  return captured;
}

describe("createVercelAiGatewayAnthropicFastModeWrapper", () => {
  it("injects speed=fast and fast-mode beta header for opus-4.6", () => {
    const captured = runFastModeWrapper({});
    expect(captured.payload?.speed).toBe("fast");
    expect(captured.headers?.["anthropic-beta"]).toContain(FAST_MODE_BETA);
  });

  it("injects for dash-variant model id anthropic/claude-opus-4-6", () => {
    const captured = runFastModeWrapper({ modelId: "anthropic/claude-opus-4-6" });
    expect(captured.payload?.speed).toBe("fast");
    expect(captured.headers?.["anthropic-beta"]).toContain(FAST_MODE_BETA);
  });

  it("leaves payload and headers untouched when disabled", () => {
    const captured = runFastModeWrapper({ enabled: false });
    expect(captured.payload?.speed).toBeUndefined();
    expect(captured.headers?.["anthropic-beta"]).toBeUndefined();
  });

  it("leaves untouched for non-anthropic model (openai/gpt-5.4)", () => {
    const captured = runFastModeWrapper({ modelId: "openai/gpt-5.4" });
    expect(captured.payload?.speed).toBeUndefined();
    expect(captured.headers?.["anthropic-beta"]).toBeUndefined();
  });

  it("leaves untouched when api is not anthropic-messages", () => {
    const captured = runFastModeWrapper({ modelApi: "openai-completions" });
    expect(captured.payload?.speed).toBeUndefined();
    expect(captured.headers?.["anthropic-beta"]).toBeUndefined();
  });

  it("leaves untouched for opus-4.5 (not fast-mode eligible)", () => {
    const captured = runFastModeWrapper({ modelId: "anthropic/claude-opus-4.5" });
    expect(captured.payload?.speed).toBeUndefined();
    expect(captured.headers?.["anthropic-beta"]).toBeUndefined();
  });

  it("merges with existing anthropic-beta header without clobbering", () => {
    const captured = runFastModeWrapper({
      existingHeaders: { "anthropic-beta": "context-1m-2025-08-07,prompt-caching-2024-07-31" },
    });
    const betas = captured.headers?.["anthropic-beta"]?.split(",") ?? [];
    expect(betas).toContain("context-1m-2025-08-07");
    expect(betas).toContain("prompt-caching-2024-07-31");
    expect(betas).toContain(FAST_MODE_BETA);
  });

  it("does not duplicate the fast-mode beta if already present", () => {
    const captured = runFastModeWrapper({
      existingHeaders: { "anthropic-beta": FAST_MODE_BETA },
    });
    const betas = captured.headers?.["anthropic-beta"]?.split(",") ?? [];
    expect(betas.filter((b) => b === FAST_MODE_BETA)).toHaveLength(1);
  });

  it("preserves an existing payload.speed value", () => {
    const captured = runFastModeWrapper({ existingPayload: { speed: "custom" } });
    expect(captured.payload?.speed).toBe("custom");
    expect(captured.headers?.["anthropic-beta"]).toContain(FAST_MODE_BETA);
  });
});

describe("resolveVercelAiGatewayFastMode", () => {
  it("returns true for boolean true", () => {
    expect(resolveVercelAiGatewayFastMode({ fastMode: true })).toBe(true);
  });

  it("returns true for string 'fast'", () => {
    expect(resolveVercelAiGatewayFastMode({ fastMode: "fast" })).toBe(true);
  });

  it("returns true for snake-case fast_mode", () => {
    expect(resolveVercelAiGatewayFastMode({ fast_mode: "on" })).toBe(true);
  });

  it("returns false for 'off'", () => {
    expect(resolveVercelAiGatewayFastMode({ fastMode: "off" })).toBe(false);
  });

  it("returns undefined for missing param", () => {
    expect(resolveVercelAiGatewayFastMode({})).toBeUndefined();
    expect(resolveVercelAiGatewayFastMode(undefined)).toBeUndefined();
  });

  it("returns undefined for unrecognized value", () => {
    expect(resolveVercelAiGatewayFastMode({ fastMode: "maybe" })).toBeUndefined();
  });
});

describe("wrapVercelAiGatewayProviderStream", () => {
  it("composes the fast-mode wrapper when extraParams.fastMode is true", () => {
    const captured: Captured = {};
    const base = buildBaseStreamFn(captured);
    const wrapped = wrapVercelAiGatewayProviderStream({
      streamFn: base,
      modelId: "anthropic/claude-opus-4.6",
      extraParams: { fastMode: true },
    } as never);
    void wrapped?.(
      {
        provider: "vercel-ai-gateway",
        api: "anthropic-messages",
        id: "anthropic/claude-opus-4.6",
      } as never,
      {} as never,
      {} as never,
    );
    expect(captured.payload?.speed).toBe("fast");
    expect(captured.headers?.["anthropic-beta"]).toContain(FAST_MODE_BETA);
  });

  it("does not wrap when extraParams.fastMode is missing", () => {
    const captured: Captured = {};
    const base = buildBaseStreamFn(captured);
    const wrapped = wrapVercelAiGatewayProviderStream({
      streamFn: base,
      modelId: "anthropic/claude-opus-4.6",
      extraParams: {},
    } as never);
    void wrapped?.(
      {
        provider: "vercel-ai-gateway",
        api: "anthropic-messages",
        id: "anthropic/claude-opus-4.6",
      } as never,
      {} as never,
      {} as never,
    );
    expect(captured.payload?.speed).toBeUndefined();
    expect(captured.headers?.["anthropic-beta"]).toBeUndefined();
  });

  it("does not wrap when extraParams.fastMode is false", () => {
    const captured: Captured = {};
    const base = buildBaseStreamFn(captured);
    const wrapped = wrapVercelAiGatewayProviderStream({
      streamFn: base,
      modelId: "anthropic/claude-opus-4.6",
      extraParams: { fastMode: false },
    } as never);
    void wrapped?.(
      {
        provider: "vercel-ai-gateway",
        api: "anthropic-messages",
        id: "anthropic/claude-opus-4.6",
      } as never,
      {} as never,
      {} as never,
    );
    expect(captured.payload?.speed).toBeUndefined();
    expect(captured.headers?.["anthropic-beta"]).toBeUndefined();
  });
});
