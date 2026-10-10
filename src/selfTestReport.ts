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

export type StageResult = {
  name: string;
  label: string;
  steps: StepResult[];
  server: PipelineStats;
};

export type ReportConfig = {
  minFrameInterval: number;
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

// The network time split into a fixed delay per update (Wi-Fi latency: radio power saving,
// retries) and a part that grows with the frame size (bandwidth), fitted from the small and
// the full-screen stage.
export type WifiEstimate = {
  fixedMs: number;
  kbPerSec?: number;
};

export type SelfTestReport = {
  stages: StageSummary[];
  minFrameInterval: MinFrameInterval;
  wifi?: WifiEstimate;
  recommendations: string[];
  config: ReportConfig;
};

// Headroom over the device's time per frame: it decodes slower while it is also receiving
// the next frames, as it does during animations and scrolling.
const MIN_FRAME_INTERVAL_MARGIN = 1.3;

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
  if (!r.steps.length || !s.framesSent) return undefined;

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

function estimateWifi(small?: StageSummary, full?: StageSummary): WifiEstimate | undefined {
  if (!small || !full || full.kbPerFrame < 2 * small.kbPerFrame) return undefined;
  const msPerKB = Math.max(0, (full.networkMs - small.networkMs) / (full.kbPerFrame - small.kbPerFrame));
  return {
    fixedMs: Math.round(Math.max(0, small.networkMs - msPerKB * small.kbPerFrame)),
    kbPerSec: msPerKB > 0 ? Math.round(1000 / msPerKB) : undefined,
  };
}

function networkAdvice(st: StageSummary, wifi: WifiEstimate | undefined, cfg: ReportConfig): string {
  if (!wifi)
    return `the network (~${st.networkMs} ms for ~${st.kbPerFrame} KB). Check the Wi-Fi signal and power_save_mode; for large frames a lower jpeg_quality (now ${cfg.jpegQuality}) also helps.`;

  const fixedMs = Math.min(wifi.fixedMs, st.networkMs);
  const transferMs = st.networkMs - fixedMs;
  const rate = wifi.kbPerSec ? ` at ~${wifi.kbPerSec} KB/s` : "";
  const split = `the network (~${st.networkMs} ms: ~${fixedMs} ms Wi-Fi latency per update + ~${transferMs} ms to transfer ~${st.kbPerFrame} KB${rate}).`;
  return fixedMs >= transferMs
    ? `${split} Most of it is latency, not bandwidth: set wifi power_save_mode: none (by default the radio sleeps between updates); a lower jpeg_quality won't help much.`
    : `${split} Most of it is the transfer: lower jpeg_quality (now ${cfg.jpegQuality}) to shrink frames, or improve the Wi-Fi signal.`;
}

function limitAdvice(st: StageSummary, wifi: WifiEstimate | undefined, cfg: ReportConfig): string {
  switch (st.limit) {
    case "browser":
      return `the browser (~${st.browserMs} ms to render the change and hand over the frame); the server and the device are fast enough.`;
    case "server":
      return `the server CPU (~${st.serverMs} ms per frame). Lower jpeg_quality (now ${cfg.jpegQuality}) or run the server on a faster host.`;
    case "network":
      return networkAdvice(st, wifi, cfg);
    case "device":
      return `the display device (~${st.deviceMs} ms to decode and draw). Lowering jpeg_quality (now ${cfg.jpegQuality}) speeds up decoding.`;
  }
}

export function buildSelfTestReport(results: StageResult[], cfg: ReportConfig): SelfTestReport {
  const stages = results.map(summarizeStage).filter((s): s is StageSummary => !!s);
  const recs: string[] = [];
  const byName = (n: string) => stages.find(s => s.name === n);
  const small = byName("small");
  const partial = byName("partial");
  const full = byName("full");

  // The interval a kind of frame needs: the busier of the server and the device, with headroom.
  const intervalFor = (st?: StageSummary) =>
    st ? roundUp10(Math.max(st.deviceMs, st.serverMs) * MIN_FRAME_INTERVAL_MARGIN) : undefined;
  const minFrameInterval: MinFrameInterval = { smoothMs: intervalFor(partial ?? small), noLagMs: intervalFor(full) };
  const { smoothMs, noLagMs } = minFrameInterval;

  if (smoothMs !== undefined && noLagMs !== undefined) {
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

  const wifi = estimateWifi(small, full);
  if (small) recs.push(`A small change (a sensor value, ~${small.kbPerFrame} KB) appears in ~${small.latencyMs} ms; limited by ${limitAdvice(small, wifi, cfg)}`);
  if (full) recs.push(`A full-screen change (switching pages, ~${full.kbPerFrame} KB) appears in ~${full.latencyMs} ms; limited by ${limitAdvice(full, wifi, cfg)}`);

  // A max far above the median is usually Wi-Fi: retransmits or the radio's power saving.
  const jittery = stages.find(s => s.latencyMaxMs > 2 * s.latencyMs + 50);
  if (jittery)
    recs.push(`Latency varies a lot (${jittery.label}: median ${jittery.latencyMs} ms, max ${jittery.latencyMaxMs} ms), ` +
      `which is typical of Wi-Fi power saving or a weak signal.`);

  const maxTile = cfg.maxBytesPerMessage - FRAME_HEADER_BYTES - TILE_HEADER_BYTES;
  const biggest = Math.max(0, ...results.map(r => r.server.maxRectBytes));
  if (biggest > 0.9 * maxTile)
    recs.push(`Tiles reached the max_bytes_per_msg limit (${round1(biggest / 1024)} of ${round1(maxTile / 1024)} KB) and were split. Raising max_bytes_per_msg, if the device has the memory, reduces per-tile overhead.`);

  return { stages, minFrameInterval, wifi, recommendations: recs, config: cfg };
}

export function formatReportForLog(report: SelfTestReport): string {
  const lines = ["[self-test] Results:"];
  for (const s of report.stages) {
    lines.push(`  ${s.label}: ${s.steps} changes, ${s.kbPerFrame} KB/frame, latency ${s.latencyMs} ms (max ${s.latencyMaxMs}) = ` +
      `browser ${s.browserMs} + server ${s.serverMs} + network ${s.networkMs} + device ${s.deviceMs}, ` +
      `limited by ${s.limit}, max tile ${s.maxTileKB} KB`);
  }
  if (report.wifi)
    lines.push(`  Wi-Fi: ~${report.wifi.fixedMs} ms per update + ${report.wifi.kbPerSec ? `~${report.wifi.kbPerSec} KB/s` : "transfer time not measurable"}`);
  for (const r of report.recommendations) lines.push(`  - ${r}`);
  return lines.join("\n");
}
