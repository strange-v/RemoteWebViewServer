import { describe, it, expect } from "vitest";
import { buildSelfTestReport, burstIntervals, StageResult, StepResult, ReportConfig } from "../src/selfTestReport.js";
import { newPipelineStats, PipelineStats } from "../src/pipelineStats.js";

const CFG: ReportConfig = { minFrameInterval: 80, maxBytesPerMessage: 14336, jpegQuality: 85 };

type Parts = Omit<StepResult, "latencyMs">;
const step = (p: Parts): StepResult => ({ ...p, latencyMs: p.browserMs + p.serverMs + p.networkMs + p.deviceMs });

// A stage of `n` identical changes with the given split of the latency and `kb` per frame.
function stage(name: string, n: number, p: Parts, kb: number, server: Partial<PipelineStats> = {}): StageResult {
  return {
    name, label: name,
    steps: Array.from({ length: n }, () => step(p)),
    server: { ...newPipelineStats(), framesSent: n, bytesSent: n * kb * 1024, ...server },
  };
}

describe("buildSelfTestReport", () => {
  it("summarizes a stage with medians of each part", () => {
    const st = stage("small", 0, { browserMs: 0, serverMs: 0, networkMs: 0, deviceMs: 0 }, 1, { framesSent: 3, bytesSent: 3 * 1024 });
    st.steps = [
      step({ browserMs: 30, serverMs: 5, networkMs: 10, deviceMs: 1 }),
      step({ browserMs: 20, serverMs: 4, networkMs: 8, deviceMs: 1 }),
      step({ browserMs: 25, serverMs: 6, networkMs: 180, deviceMs: 2 }),
    ];
    const r = buildSelfTestReport([st], CFG);
    expect(r.stages[0]).toMatchObject({
      steps: 3, kbPerFrame: 1, latencyMs: 46, latencyMaxMs: 213,
      browserMs: 25, serverMs: 5, networkMs: 10, deviceMs: 1, limit: "browser",
    });
  });

  it("names the largest measured part as the limit", () => {
    const r = buildSelfTestReport([
      stage("small", 5, { browserMs: 40, serverMs: 5, networkMs: 8, deviceMs: 1 }, 1),
      stage("partial", 5, { browserMs: 20, serverMs: 8, networkMs: 15, deviceMs: 40 }, 8),
      stage("full", 5, { browserMs: 20, serverMs: 10, networkMs: 90, deviceMs: 45 }, 20),
      stage("cpu", 5, { browserMs: 20, serverMs: 80, networkMs: 10, deviceMs: 20 }, 10),
    ], CFG);
    expect(r.stages.map(s => s.limit)).toEqual(["browser", "device", "network", "server"]);
  });

  // ESP32-S3, 480x480: ~13 ms per partial frame, ~45 ms per full one
  const deviceStages = () => [
    stage("small", 5, { browserMs: 40, serverMs: 5, networkMs: 8, deviceMs: 1 }, 1),
    stage("partial", 5, { browserMs: 60, serverMs: 6, networkMs: 70, deviceMs: 13 }, 8),
    stage("full", 5, { browserMs: 20, serverMs: 6, networkMs: 90, deviceMs: 45 }, 20),
  ];

  it("recommends one interval for smooth animations and one for no lag on full-screen changes", () => {
    const r = buildSelfTestReport(deviceStages(), CFG);
    // 13 * 1.3 = 16.9 -> 20 ms; 45 * 1.3 = 58.5 -> 60 ms
    expect(r.minFrameInterval).toEqual({ smoothMs: 20, noLagMs: 60 });
    expect(r.recommendations[0]).toContain("20 ms for smooth animations");
    expect(r.recommendations[0]).toContain("or 60 ms so the screen doesn't lag");
  });

  // 2 s of full-screen changes at `intervalMs`, `frames` sent, device `lagMs` behind at the end
  const burst = (intervalMs: number, frames: number, lagMs: number, timedOut = false): StageResult => ({
    name: `burst-${intervalMs}`, label: "Scrolling", steps: [],
    server: { ...newPipelineStats(), framesSent: frames },
    burst: { intervalMs, changesMs: 2000, lagMs, timedOut },
  });

  it("runs bursts at the configured interval and both estimates", () => {
    expect(burstIntervals(deviceStages(), 20)).toEqual([20, 60]);  // configured 20 = smooth estimate
    expect(burstIntervals(deviceStages(), 80)).toEqual([20, 60, 80]);
    expect(burstIntervals([], 80)).toEqual([80]);
  });

  it("recommends the burst interval with the most frames that keeps up", () => {
    // full screen: 161 ms latency, 45 ms on the device -> at 20 ms lagging above 161 + 2 * 45 = 251 ms
    const r = buildSelfTestReport([...deviceStages(), burst(20, 60, 700), burst(60, 34, 150), burst(80, 25, 120)], CFG);
    expect(r.bursts.map(b => [b.intervalMs, b.fps, b.lagging])).toEqual([[20, 22.2, true], [60, 15.8, false], [80, 11.8, false]]);
    expect(r.recommendedMinFrameIntervalMs).toBe(60);
    expect(r.recommendations[0]).toContain("20 ms: 22.2 fps, 700 ms behind");
    expect(r.recommendations[1]).toContain("60 ms gives the most frames while scrolling (15.8 fps) without the screen lagging behind (now 80 ms)");
  });

  it("prefers a higher interval when a lower one gave fewer frames", () => {
    // ESP32-P4 over Ethernet: the device is fast, the server's CPU is shared with the browser
    const p4 = [
      stage("small", 5, { browserMs: 13, serverMs: 5, networkMs: 3, deviceMs: 0 }, 1.2),
      stage("partial", 5, { browserMs: 19, serverMs: 6, networkMs: 4, deviceMs: 5 }, 10.6),
      stage("full", 5, { browserMs: 21, serverMs: 9, networkMs: 10, deviceMs: 16 }, 30.6),
    ];
    const r = buildSelfTestReport([...p4, burst(10, 50, 83), burst(30, 62, 128)], { ...CFG, minFrameInterval: 10, frameAcks: true });
    // 128 ms behind is below the 150 ms nobody notices: not lagging
    expect(r.bursts.map(b => b.lagging)).toEqual([false, false]);
    expect(r.recommendedMinFrameIntervalMs).toBe(30);
    expect(r.recommendations[1]).toContain("30 ms gives the most frames while scrolling (29.1 fps)");
    expect(r.recommendations[2]).toContain("A lower interval gave fewer frames (10 ms: 24 fps)");
  });

  it("prefers the lower interval when the frame rates are about equal", () => {
    const r = buildSelfTestReport([...deviceStages(), burst(20, 40, 100), burst(60, 41, 100)], { ...CFG, frameAcks: true });
    expect(r.recommendedMinFrameIntervalMs).toBe(20);
  });

  it("says so when the screen lags at every tested interval", () => {
    const r = buildSelfTestReport([...deviceStages(), burst(20, 50, 900), burst(60, 30, 0, true)], CFG);
    expect(r.recommendedMinFrameIntervalMs).toBeUndefined();
    expect(r.recommendations[1]).toContain("lagged behind at every tested min_frame_interval: try ~90 ms");
  });

  it("explains where the current min_frame_interval falls", () => {
    const say = (cur: number) => buildSelfTestReport(deviceStages(), { ...CFG, minFrameInterval: cur }).recommendations[1];
    expect(say(10)).toContain("lower than the device keeps up with even for partial updates");
    expect(say(20)).toContain("suits animations; full-screen changes in a row (scrolling) may lag");
    expect(say(200)).toContain("caps animations at 5 fps; 60 ms is enough even for full-screen changes");
  });

  it("points at Wi-Fi when the latency varies a lot", () => {
    const st = stage("partial", 4, { browserMs: 20, serverMs: 6, networkMs: 30, deviceMs: 13 }, 8);
    st.steps.push(step({ browserMs: 20, serverMs: 6, networkMs: 250, deviceMs: 13 }));
    const r = buildSelfTestReport([st], CFG);
    expect(r.recommendations.some(t => t.includes("on Wi-Fi is typical of power saving"))).toBe(true);
  });

  it("splits the network time into Wi-Fi latency and transfer", () => {
    // From a real ESP32-S3: 1.1 KB took 42 ms on the network, 20.5 KB took 93 ms
    const r = buildSelfTestReport([
      stage("small", 5, { browserMs: 14, serverMs: 7, networkMs: 42, deviceMs: 1 }, 1.1),
      stage("full", 5, { browserMs: 12, serverMs: 7, networkMs: 93, deviceMs: 45 }, 20.5),
    ], CFG);
    // (93 - 42) / (20.5 - 1.1) = 2.63 ms/KB -> ~380 KB/s; 42 - 2.63 * 1.1 = 39 ms fixed
    expect(r.network).toEqual({ fixedMs: 39, kbPerSec: 380 });
    const small = r.recommendations.find(t => t.startsWith("A small change"))!;
    expect(small).toContain("~39 ms network latency per update + ~3 ms to transfer");
    expect(small).toContain("Most of it is latency, not bandwidth: on Wi-Fi set power_save_mode: none");
    const full = r.recommendations.find(t => t.startsWith("A full-screen change"))!;
    expect(full).toContain("~39 ms network latency per update + ~54 ms to transfer ~20.5 KB at ~380 KB/s");
    expect(full).toContain("Most of it is the transfer: lower jpeg_quality");
  });

  it("warns when tiles reach max_bytes_per_msg", () => {
    const r = buildSelfTestReport([stage("full", 5, { browserMs: 20, serverMs: 8, networkMs: 30, deviceMs: 45 }, 20, { maxRectBytes: 14000 })], CFG);
    expect(r.recommendations.some(t => t.includes("max_bytes_per_msg"))).toBe(true);
  });

  it("skips stages without measured changes", () => {
    const r = buildSelfTestReport([stage("full", 0, { browserMs: 0, serverMs: 0, networkMs: 0, deviceMs: 0 }, 0)], CFG);
    expect(r.stages).toHaveLength(0);
    expect(r.minFrameInterval).toEqual({ smoothMs: undefined, noLagMs: undefined });
    expect(r.recommendations[0]).toContain("No frames were measured");
  });
});
