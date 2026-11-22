import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRenderModule } from "../../src/render/index.js";
import { fakeLimits, memoryLog } from "./helpers.js";

describe("render module", () => {
  it("wires the runner, renderFinal and the Prepare helpers", async () => {
    const module = createRenderModule({
      dataDir: "/tmp/vidai-nowhere",
      clock: { now: () => 0 },
      log: memoryLog(),
      limits: fakeLimits().api,
      sink: { push: () => {} },
      library: /** @type {never} */ ({}),
      timeline: /** @type {never} */ ({}),
      activeJob: () => null,
      enqueue: /** @type {never} */ (() => ({})),
      hyperframesBin: "/pkg/bin/hyperframes.mjs",
    });
    assert.equal(module.name, "render");
    assert.deepEqual(
      module.rpc.map((f) => [f.name, f.access]),
      [["renderFinal", "user"]],
    );
    assert.equal(typeof module.runner.run, "function");
    assert.equal(typeof module.runner.sweep, "function");
    assert.equal(await module.runner.sweep(), 0);
    assert.equal(typeof module.prepare.ensureBrowser, "function");
    assert.equal(typeof module.prepare.testRender, "function");
  });
});
