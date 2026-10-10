import { describe, it, expect } from "vitest";
import { buildSelfTestReport, StageResult, ReportConfig } from "../src/selfTestReport.js";
import { newPipelineStats, PipelineStats } from "../src/pipelineStats.js";

const CFG: ReportConfig = { minFrameInterval: 80, maxBytesPerMessage: 14336, jpegQuality: 85 };

// A stage of `n` identical changes: each took `latencyMs` end to end and `deviceMs` on the device,
// with `serverMs` of server processing and `kb` per frame.
function stage(name: string, n: number, latencyMs: number, deviceMs: number, serverMs: number, kb: number, server: Partial<PipelineStats> = {}): StageResult {
  return {
    name, label: name,
    steps: Array.from({ length: n }, () => ({ latencyMs, deviceMs })),
    server: { ...newPipelineStats(), framesSent: n, bytesSent: n * kb * 1024, procMsTotal: n * serverMs, ...server },
  };
}

describe("buildSelfTestReport", () => {
  it("summarizes a stage with medians", () => {
    const st = stage("small", 3, 0, 0, 5, 1);
    st.steps = [{ latencyMs: 40, deviceMs: 8 }, { latencyMs: 30, deviceMs: 6 }, { latencyMs: 90, deviceMs: 20 }];
    const r = buildSelfTestReport([st], CFG);
    expect(r.stages[0]).toMatchObject({ steps: 3, kbPerFrame: 1, latencyMs: 40, latencyMaxMs: 90, serverMs: 5, deviceMs: 8 });
  });

  it("names the largest part of the latency as the limit", () => {
    const r = buildSelfTestReport([
      stage("small", 5, 40, 8, 5, 1),     // 27 ms left over, small frames: the browser
      stage("partial", 5, 60, 40, 8, 4),  // the device
      stage("full", 5, 200, 75, 10, 23),  // 115 ms left over, big frames: the network
      stage("cpu", 5, 120, 20, 80, 10),   // the server
    ], CFG);
    expect(r.stages.map(s => s.limit)).toEqual(["browser", "device", "network", "server"]);
  });

  it("bases min_frame_interval on the device time for full-screen frames", () => {
    // ESP32-S3 software decode of a 480x480 frame: ~75 ms -> at least 90 ms
    const r = buildSelfTestReport([stage("small", 5, 40, 8, 5, 1), stage("full", 5, 120, 75, 10, 23)], CFG);
    expect(r.recommendedMinFrameInterval).toBe(90);
    expect(r.recommendations.some(t => t.includes("too low for this device"))).toBe(true);
  });

  it("suggests lowering a min_frame_interval that is far above what the device needs", () => {
    const r = buildSelfTestReport([stage("full", 5, 60, 20, 8, 23)], { ...CFG, minFrameInterval: 200 });
    expect(r.recommendedMinFrameInterval).toBe(30);
    expect(r.recommendations.some(t => t.includes("caps animations at 5 fps"))).toBe(true);
  });

  it("warns when tiles reach max_bytes_per_msg", () => {
    const r = buildSelfTestReport([stage("full", 5, 120, 75, 10, 23, { maxRectBytes: 14000 })], CFG);
    expect(r.recommendations.some(t => t.includes("max_bytes_per_msg"))).toBe(true);
  });

  it("skips stages without measured changes", () => {
    const r = buildSelfTestReport([stage("full", 0, 0, 0, 0, 0)], CFG);
    expect(r.stages).toHaveLength(0);
    expect(r.recommendedMinFrameInterval).toBeUndefined();
    expect(r.recommendations[0]).toContain("No frames were measured");
  });
});
