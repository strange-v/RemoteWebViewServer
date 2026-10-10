import type { PipelineStats } from "./pipelineStats.js";
import { FRAME_HEADER_BYTES, TILE_HEADER_BYTES } from "./protocol.js";

// One change on the test page, from the change until the device confirmed it drew the frame.
export type StepResult = { latencyMs: number; deviceMs: number };

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

export type Limit = "device" | "server" | "network" | "browser";

export type StageSummary = {
  name: string;
  label: string;
  steps: number;
  kbPerFrame: number;
  latencyMs: number;      // median: page change -> drawn on the device
  latencyMaxMs: number;
  serverMs: number;       // median server processing per frame
  deviceMs: number;       // median decode + draw on the device
  limit: Limit;           // the largest part of the latency
  maxTileKB: number;
};

export type SelfTestReport = {
  stages: StageSummary[];
  recommendedMinFrameInterval?: number;
  recommendations: string[];
  config: ReportConfig;
};

// Above this size per frame the transfer, not the browser, dominates what's left of the latency.
const NETWORK_KB_THRESHOLD = 8;

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

  const latencyMs = Math.round(median(r.steps.map(x => x.latencyMs)));
  const deviceMs = Math.round(median(r.steps.map(x => x.deviceMs)));
  const serverMs = round1(s.procMsTotal / s.framesSent);
  const kbPerFrame = round1(s.bytesSent / s.framesSent / 1024);

  // Whatever the server and the device don't account for is the browser rendering the
  // change plus the transfer; which of the two dominates depends on the frame size.
  const rest = Math.max(0, latencyMs - serverMs - deviceMs);
  const parts: [Limit, number][] = [
    ["device", deviceMs],
    ["server", serverMs],
    [kbPerFrame >= NETWORK_KB_THRESHOLD ? "network" : "browser", rest],
  ];
  parts.sort((a, b) => b[1] - a[1]);

  return {
    name: r.name,
    label: r.label,
    steps: r.steps.length,
    kbPerFrame,
    latencyMs,
    latencyMaxMs: Math.round(Math.max(...r.steps.map(x => x.latencyMs))),
    serverMs,
    deviceMs,
    limit: parts[0][0],
    maxTileKB: round1(s.maxRectBytes / 1024),
  };
}

function limitAdvice(st: StageSummary, cfg: ReportConfig): string {
  switch (st.limit) {
    case "device":
      return `the display device (~${st.deviceMs} ms to decode and draw). Lowering jpeg_quality (now ${cfg.jpegQuality}) speeds up decoding.`;
    case "server":
      return `the server CPU (~${st.serverMs} ms per frame). Lower jpeg_quality (now ${cfg.jpegQuality}) or run the server on a faster host.`;
    case "network":
      return `the network (~${st.kbPerFrame} KB per frame). Lower jpeg_quality (now ${cfg.jpegQuality}) to shrink frames, or improve the Wi-Fi signal.`;
    case "browser":
      return `the browser rendering the change; the server and the device are fast enough.`;
  }
}

export function buildSelfTestReport(results: StageResult[], cfg: ReportConfig): SelfTestReport {
  const stages = results.map(summarizeStage).filter((s): s is StageSummary => !!s);
  const recs: string[] = [];
  const byName = (n: string) => stages.find(s => s.name === n);
  const small = byName("small");
  const partial = byName("partial");
  const full = byName("full");

  // The device has no flow control of its own: frames that come faster than it can draw them
  // overflow its queue (and can trip its watchdog). min_frame_interval is what protects it, so
  // it must cover the slowest common frame - a full-screen one, e.g. while scrolling.
  const worst = full ?? partial ?? small;
  let recommendedMinFrameInterval: number | undefined;
  if (worst) {
    const busyMs = Math.max(worst.deviceMs, worst.serverMs);
    recommendedMinFrameInterval = roundUp10(busyMs * 1.15);
    recs.push(`min_frame_interval: at least ${recommendedMinFrameInterval} ms. The device needs ~${worst.deviceMs} ms for a ` +
      `${worst === full ? "full-screen" : "large"} frame; sending faster (e.g. while scrolling) overflows its queue.`);
    const cur = cfg.minFrameInterval;
    if (cur < recommendedMinFrameInterval)
      recs.push(`The current ${cur} ms is too low for this device: raise it to avoid dropped frames.`);
    else if (cur > recommendedMinFrameInterval * 1.5)
      recs.push(`The current ${cur} ms is safe but caps animations at ${Math.round(1000 / cur)} fps; you can lower it to ${recommendedMinFrameInterval} ms.`);
  } else {
    recs.push("No frames were measured: is the device connected and drawing?");
  }

  if (small) recs.push(`A small change (a sensor value, ~${small.kbPerFrame} KB) appears in ~${small.latencyMs} ms; limited by ${limitAdvice(small, cfg)}`);
  if (full) recs.push(`A full-screen change (switching pages, ~${full.kbPerFrame} KB) appears in ~${full.latencyMs} ms; limited by ${limitAdvice(full, cfg)}`);

  const maxTile = cfg.maxBytesPerMessage - FRAME_HEADER_BYTES - TILE_HEADER_BYTES;
  const biggest = Math.max(0, ...results.map(r => r.server.maxRectBytes));
  if (biggest > 0.9 * maxTile)
    recs.push(`Tiles reached the max_bytes_per_msg limit (${round1(biggest / 1024)} of ${round1(maxTile / 1024)} KB) and were split. Raising max_bytes_per_msg, if the device has the memory, reduces per-tile overhead.`);

  return { stages, recommendedMinFrameInterval, recommendations: recs, config: cfg };
}

export function formatReportForLog(report: SelfTestReport): string {
  const lines = ["[self-test] Results:"];
  for (const s of report.stages) {
    lines.push(`  ${s.label}: ${s.steps} changes, ${s.kbPerFrame} KB/frame, latency ${s.latencyMs} ms (max ${s.latencyMaxMs}), ` +
      `server ${s.serverMs} ms, device ${s.deviceMs} ms, limited by ${s.limit}, max tile ${s.maxTileKB} KB`);
  }
  for (const r of report.recommendations) lines.push(`  - ${r}`);
  return lines.join("\n");
}
