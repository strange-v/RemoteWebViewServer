import type { PipelineStats } from "./pipelineStats.js";
import { FRAME_HEADER_BYTES, TILE_HEADER_BYTES } from "./protocol.js";

// One change on the test page, from the change until the device confirmed it drew the frame,
// split into the parts of the pipeline. All in ms.
export type StepResult = {
  latencyMs: number;
  browserMs: number;  // change -> frame from the screencast (render, PNG encode, CDP)
  serverMs: number;   // frame received -> sent (waiting + decode, diff, JPEG encode)
  networkMs: number;  // sent -> confirmed by the device, minus its own decode and draw
  deviceMs: number;   // decode + draw on the device, as the device reports it
};

// A burst stage: the whole screen changed on every browser frame for changesMs, paced by
// intervalMs (min_frame_interval for the stage). lagMs is how long after the last change the
// device confirmed the last frame, i.e. how far it had fallen behind.
export type BurstResult = {
  intervalMs: number;
  changesMs: number;
  lagMs: number;
  timedOut: boolean;
};

export type StageResult = {
  name: string;
  label: string;
  steps: StepResult[];
  server: PipelineStats;
  burst?: BurstResult;
};

export type ReportConfig = {
  minFrameInterval: number;
  frameAcks?: boolean;   // the device acknowledges frames, so the server paces itself to it
  maxBytesPerMessage: number;
  jpegQuality: number;
};

export type Limit = "browser" | "server" | "network" | "device";

export type StageSummary = {
  name: string;
  label: string;
  steps: number;
  kbPerFrame: number;
  // medians over the stage's changes
  latencyMs: number;
  browserMs: number;
  serverMs: number;
  networkMs: number;
  deviceMs: number;
  latencyMaxMs: number;
  limit: Limit;       // the largest part of the latency
  maxTileKB: number;
};

// Recommended min_frame_interval. One value can't fit all frame sizes: frames that come faster
// than the device draws them queue up on it before backpressure reaches the server, so the
// screen lags behind. A short interval keeps animations (partial updates) smooth but lets
// full-screen changes lag; a long one avoids the lag but caps animations.
export type MinFrameInterval = {
  smoothMs?: number;  // for partial updates: smooth animations
  noLagMs?: number;   // for full-screen updates: no lag while scrolling or switching pages
};

// The network time split into a fixed delay per update (latency: e.g. Wi-Fi power saving or
// retries) and a part that grows with the frame size (bandwidth), fitted from the small and
// the full-screen stage.
export type NetworkEstimate = {
  fixedMs: number;
  kbPerSec?: number;
};

export type BurstSummary = {
  intervalMs: number;
  fps: number;        // frames the device showed per second, until it caught up
  frames: number;
  lagMs: number;      // behind the page at the end of the burst
  lagging: boolean;   // noticeably behind: see summarizeBurst
  timedOut: boolean;
};

export type SelfTestReport = {
  stages: StageSummary[];
  bursts: BurstSummary[];
  // The burst interval with the most frames and no noticeable lag, when bursts were measured.
  recommendedMinFrameIntervalMs?: number;
  minFrameInterval: MinFrameInterval;
  network?: NetworkEstimate;
  recommendations: string[];
  config: ReportConfig;
};

// Headroom over the device's time per frame: it decodes slower while it is also receiving
// the next frames, as it does during animations and scrolling.
const MIN_FRAME_INTERVAL_MARGIN = 1.3;

// A lag at the end of scrolling shorter than this isn't noticeable.
const UNNOTICEABLE_LAG_MS = 150;
// Frame rates within this fraction of the best count as equal; the lower interval wins.
const FPS_TOLERANCE = 0.05;

const round1 = (v: number) => Math.round(v * 10) / 10;
const roundUp10 = (v: number) => Math.max(10, Math.ceil(v / 10) * 10);

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function summarizeStage(r: StageResult): StageSummary | undefined {
  const s = r.server;
  if (r.burst || !r.steps.length || !s.framesSent) return undefined;

  const med = (pick: (x: StepResult) => number) => Math.round(median(r.steps.map(pick)));
  const parts: Record<Limit, number> = {
    browser: med(x => x.browserMs),
    server: med(x => x.serverMs),
    network: med(x => x.networkMs),
    device: med(x => x.deviceMs),
  };
  const limit = (Object.keys(parts) as Limit[]).reduce((a, b) => parts[b] > parts[a] ? b : a);

  return {
    name: r.name,
    label: r.label,
    steps: r.steps.length,
    kbPerFrame: round1(s.bytesSent / s.framesSent / 1024),
    latencyMs: med(x => x.latencyMs),
    browserMs: parts.browser,
    serverMs: parts.server,
    networkMs: parts.network,
    deviceMs: parts.device,
    latencyMaxMs: Math.round(Math.max(...r.steps.map(x => x.latencyMs))),
    limit,
    maxTileKB: round1(s.maxRectBytes / 1024),
  };
}

function estimateNetwork(small?: StageSummary, full?: StageSummary): NetworkEstimate | undefined {
  if (!small || !full || full.kbPerFrame < 2 * small.kbPerFrame) return undefined;
  const msPerKB = Math.max(0, (full.networkMs - small.networkMs) / (full.kbPerFrame - small.kbPerFrame));
  return {
    fixedMs: Math.round(Math.max(0, small.networkMs - msPerKB * small.kbPerFrame)),
    kbPerSec: msPerKB > 0 ? Math.round(1000 / msPerKB) : undefined,
  };
}

function networkAdvice(st: StageSummary, network: NetworkEstimate | undefined, cfg: ReportConfig): string {
  if (!network)
    return `the network (~${st.networkMs} ms for ~${st.kbPerFrame} KB). On Wi-Fi check the signal and power_save_mode; for large frames a lower jpeg_quality (now ${cfg.jpegQuality}) also helps.`;

  const fixedMs = Math.min(network.fixedMs, st.networkMs);
  const transferMs = st.networkMs - fixedMs;
  const rate = network.kbPerSec ? ` at ~${network.kbPerSec} KB/s` : "";
  const split = `the network (~${st.networkMs} ms: ~${fixedMs} ms network latency per update + ~${transferMs} ms to transfer ~${st.kbPerFrame} KB${rate}).`;
  return fixedMs >= transferMs
    ? `${split} Most of it is latency, not bandwidth: on Wi-Fi set power_save_mode: none (by default the radio sleeps between updates); a lower jpeg_quality won't help much.`
    : `${split} Most of it is the transfer: lower jpeg_quality (now ${cfg.jpegQuality}) to shrink frames, or improve the connection.`;
}

function limitAdvice(st: StageSummary, network: NetworkEstimate | undefined, cfg: ReportConfig): string {
  switch (st.limit) {
    case "browser":
      return `the browser (~${st.browserMs} ms to render the change and hand over the frame); the server and the device are fast enough.`;
    case "server":
      return `the server CPU (~${st.serverMs} ms per frame). Lower jpeg_quality (now ${cfg.jpegQuality}) or run the server on a faster host.`;
    case "network":
      return networkAdvice(st, network, cfg);
    case "device":
      return `the display device (~${st.deviceMs} ms to decode and draw). Lowering jpeg_quality (now ${cfg.jpegQuality}) speeds up decoding.`;
  }
}

// The interval a kind of frame needs: the busier of the server and the device, with headroom.
const intervalFor = (st?: StageSummary) =>
  st ? roundUp10(Math.max(st.deviceMs, st.serverMs) * MIN_FRAME_INTERVAL_MARGIN) : undefined;

// The intervals the burst stages should run at: the configured one and the two estimates,
// so the user sees the trade-off without changing the device's configuration.
export function burstIntervals(results: StageResult[], configuredMs: number): number[] {
  const stages = results.map(summarizeStage).filter((s): s is StageSummary => !!s);
  const byName = (n: string) => stages.find(s => s.name === n);
  const candidates = [configuredMs, intervalFor(byName("partial") ?? byName("small")), intervalFor(byName("full"))];
  return [...new Set(candidates.filter((v): v is number => v !== undefined))].sort((a, b) => a - b);
}

function summarizeBurst(r: StageResult, full: StageSummary | undefined): BurstSummary {
  const b = r.burst!;
  const frames = r.server.framesSent;
  // Falling behind means more than one full-screen change takes on its own, plus two frame
  // periods (frames still in flight), and never less than a lag people don't notice.
  const framePeriodMs = Math.max(b.intervalMs, full?.deviceMs ?? 50);
  const allowedMs = Math.max(UNNOTICEABLE_LAG_MS, (full?.latencyMs ?? 100) + 2 * framePeriodMs);
  return {
    intervalMs: b.intervalMs,
    fps: round1(frames / (Math.max(b.changesMs + b.lagMs, 1) / 1000)),
    frames,
    lagMs: Math.round(b.lagMs),
    lagging: b.timedOut || b.lagMs > allowedMs,
    timedOut: b.timedOut,
  };
}

export function buildSelfTestReport(results: StageResult[], cfg: ReportConfig): SelfTestReport {
  const stages = results.map(summarizeStage).filter((s): s is StageSummary => !!s);
  const recs: string[] = [];
  const byName = (n: string) => stages.find(s => s.name === n);
  const small = byName("small");
  const partial = byName("partial");
  const full = byName("full");

  const minFrameInterval: MinFrameInterval = { smoothMs: intervalFor(partial ?? small), noLagMs: intervalFor(full) };
  const { smoothMs, noLagMs } = minFrameInterval;

  const bursts = results.filter(r => r.burst).map(r => summarizeBurst(r, full)).sort((a, b) => a.intervalMs - b.intervalMs);
  // Among the intervals without lag, the one with the most frames; a lower interval only when
  // it is about as smooth. A lower interval isn't always smoother: the server shares its CPU
  // with the browser, so processing more frames can make the browser render fewer.
  const keepsUp = bursts.filter(b => !b.lagging);
  const bestFps = Math.max(0, ...keepsUp.map(b => b.fps));
  const best = keepsUp.find(b => b.fps >= bestFps * (1 - FPS_TOLERANCE));
  const recommendedMinFrameIntervalMs = best?.intervalMs;

  if (bursts.length) {
    // Measured directly while scrolling.
    const lines = bursts.map(b => `${b.intervalMs} ms: ${b.fps} fps, ${b.timedOut ? "didn't catch up" : `${b.lagMs} ms behind`}`);
    recs.push(`Scrolling (the whole screen changing for 2 s): ${lines.join("; ")}.` +
      (cfg.frameAcks ? " The device acknowledges frames, so the server doesn't send more than it can draw." : ""));
    if (best) {
      recs.push(`min_frame_interval: ${best.intervalMs} ms gives the most frames while scrolling (${best.fps} fps) without the screen lagging behind` +
        (cfg.minFrameInterval === best.intervalMs ? " (your current value)." : ` (now ${cfg.minFrameInterval} ms).`) +
        (cfg.frameAcks ? "" : ` Lower values make the screen lag behind on full-screen changes.`));
      const slower = bursts.find(b => b.intervalMs < best.intervalMs && b.fps < best.fps * (1 - FPS_TOLERANCE));
      if (slower)
        recs.push(`A lower interval gave fewer frames (${slower.intervalMs} ms: ${slower.fps} fps): the server shares its CPU with the browser rendering the page, so processing more frames left it less time to render.`);
    } else {
      recs.push(`The screen lagged behind at every tested min_frame_interval: try ~${Math.round(Math.max(...bursts.map(b => b.intervalMs)) * 1.5)} ms, a lower jpeg_quality (now ${cfg.jpegQuality}) or a smaller decode queue on the device.`);
    }
  } else if (smoothMs !== undefined && noLagMs !== undefined) {
    recs.push(`min_frame_interval: ${smoothMs} ms for smooth animations (the device draws a partial update in ~${(partial ?? small)!.deviceMs} ms), ` +
      `or ${noLagMs} ms so the screen doesn't lag behind when all of it changes, e.g. while scrolling (~${full!.deviceMs} ms per frame). ` +
      `Anything in between trades one for the other.`);
    const cur = cfg.minFrameInterval;
    if (cur < smoothMs)
      recs.push(`The current ${cur} ms is lower than the device keeps up with even for partial updates: frames queue up and the screen lags.`);
    else if (cur < noLagMs)
      recs.push(`The current ${cur} ms suits animations; full-screen changes in a row (scrolling) may lag behind.`);
    else if (cur > noLagMs * 1.5)
      recs.push(`The current ${cur} ms caps animations at ${Math.round(1000 / cur)} fps; ${noLagMs} ms is enough even for full-screen changes.`);
  } else if (smoothMs !== undefined || noLagMs !== undefined) {
    recs.push(`min_frame_interval: ~${smoothMs ?? noLagMs} ms (not all stages were measured).`);
  } else {
    recs.push("No frames were measured: is the device connected and drawing?");
  }

  const network = estimateNetwork(small, full);
  if (small) recs.push(`A small change (a sensor value, ~${small.kbPerFrame} KB) appears in ~${small.latencyMs} ms; limited by ${limitAdvice(small, network, cfg)}`);
  if (full) recs.push(`A full-screen change (switching pages, ~${full.kbPerFrame} KB) appears in ~${full.latencyMs} ms; limited by ${limitAdvice(full, network, cfg)}`);

  // A max far above the median is usually Wi-Fi: retransmits or the radio's power saving.
  const jittery = stages.find(s => s.latencyMaxMs > 2 * s.latencyMs + 50);
  if (jittery)
    recs.push(`Latency varies a lot (${jittery.label}: median ${jittery.latencyMs} ms, max ${jittery.latencyMaxMs} ms), ` +
      `which on Wi-Fi is typical of power saving or a weak signal.`);

  const maxTile = cfg.maxBytesPerMessage - FRAME_HEADER_BYTES - TILE_HEADER_BYTES;
  const biggest = Math.max(0, ...results.map(r => r.server.maxRectBytes));
  if (biggest > 0.9 * maxTile)
    recs.push(`Tiles reached the max_bytes_per_msg limit (${round1(biggest / 1024)} of ${round1(maxTile / 1024)} KB) and were split. Raising max_bytes_per_msg, if the device has the memory, reduces per-tile overhead.`);

  return { stages, bursts, recommendedMinFrameIntervalMs, minFrameInterval, network, recommendations: recs, config: cfg };
}

export function formatReportForLog(report: SelfTestReport): string {
  const lines = ["[self-test] Results:"];
  for (const s of report.stages) {
    lines.push(`  ${s.label}: ${s.steps} changes, ${s.kbPerFrame} KB/frame, latency ${s.latencyMs} ms (max ${s.latencyMaxMs}) = ` +
      `browser ${s.browserMs} + server ${s.serverMs} + network ${s.networkMs} + device ${s.deviceMs}, ` +
      `limited by ${s.limit}, max tile ${s.maxTileKB} KB`);
  }
  for (const b of report.bursts)
    lines.push(`  Burst at ${b.intervalMs} ms: ${b.frames} frames, ${b.fps} fps, ${b.timedOut ? "didn't catch up" : `${b.lagMs} ms behind`}${b.lagging ? " (lagging)" : ""}`);
  if (report.network)
    lines.push(`  Network: ~${report.network.fixedMs} ms per update + ${report.network.kbPerSec ? `~${report.network.kbPerSec} KB/s` : "transfer time not measurable"}`);
  for (const r of report.recommendations) lines.push(`  - ${r}`);
  return lines.join("\n");
}
