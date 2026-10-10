import { describe, it, expect, vi, afterEach } from "vitest";
import { SelfTestRunner } from "../src/selfTest.js";
import { newPipelineStats } from "../src/pipelineStats.js";

// A device whose CDP session only records what the runner evaluates on the page.
function fakeDevice() {
  const handlers: Record<string, (evt: any) => void> = {};
  const evaluated: string[] = [];
  const dev: any = {
    deviceId: "d",
    cfg: { minFrameInterval: 20, maxBytesPerMessage: 61440, jpegQuality: 85 },
    stats: newPipelineStats(),
    acks: { supported: false },
    cdp: {
      on: (name: string, cb: (evt: any) => void) => { handlers[name] = cb; },
      send: async (method: string, params?: any) => {
        if (method === "Runtime.evaluate") evaluated.push(params.expression);
        return {};
      },
    },
  };
  const page = (msg: object) => handlers["Runtime.bindingCalled"]({ name: "rwvSelfTest", payload: JSON.stringify(msg) });
  return { dev, page, evaluated };
}

const broadcaster: any = { requestFrameStats: () => true };
const continues = (evaluated: string[]) => evaluated.filter(e => e.includes("rwvContinue")).length;

afterEach(() => { vi.useRealTimers(); });

describe("SelfTestRunner", () => {
  it("records a late reply with its own step's timing and doesn't let it end the next step", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { dev, page, evaluated } = fakeDevice();
    const runner = new SelfTestRunner(broadcaster);
    await runner.startAsync(dev);

    page({ type: "stage-start", name: "full", label: "Full screen" });
    runner.handleClientStats({ avgRenderMs: 0, bytes: 0 }); // reply to the reset request

    // Step 1: its frame goes out at 20 ms, but the device takes long to confirm it.
    page({ type: "step" });
    vi.setSystemTime(20);
    dev.onFrameSent(10, 20);

    // The page gives up after 3 s and makes step 2; its frame goes out at 3050 ms.
    vi.setSystemTime(3000);
    page({ type: "step" });
    vi.setSystemTime(3050);
    dev.onFrameSent(3040, 3050);

    // Step 1's reply arrives at 3160 ms: it took 3160 ms, and step 2 must keep waiting.
    vi.setSystemTime(3160);
    runner.handleClientStats({ avgRenderMs: 45, bytes: 0 });
    expect(continues(evaluated)).toBe(0);

    // Step 2's reply arrives at 3200 ms and lets the page continue.
    vi.setSystemTime(3200);
    runner.handleClientStats({ avgRenderMs: 45, bytes: 0 });
    expect(continues(evaluated)).toBe(1);

    const stage = (runner as any)._stage;
    expect(stage.steps.map((s: any) => s.latencyMs)).toEqual([3160, 200]);
    expect(stage.steps[1]).toMatchObject({ browserMs: 40, serverMs: 10, deviceMs: 45, networkMs: 105 });
  });
});
