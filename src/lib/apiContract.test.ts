import { describe, expect, expectTypeOf, it } from "vitest";
import type { Api } from "./api";
import { createHttpApi } from "./http";
import { MockBackend } from "./mock";

describe("Api contract", () => {
  it("is satisfied by the mock backend and the HTTP backend", () => {
    expectTypeOf<MockBackend>().toExtend<Api>();
    expectTypeOf(createHttpApi()).toExtend<Api>();
    const mock = new MockBackend({ latencyMs: 0, autoTick: false });
    const http = createHttpApi();
    expect(mock.backend).toBe("mock");
    expect(http.backend).toBe("http");
    expect(mock.playerScriptUrl).toBe("/assets/hyperframes-player.js");
    expect(http.playerScriptUrl).toBe("/assets/hyperframes-player.js");
    mock.dispose();
  });
});
