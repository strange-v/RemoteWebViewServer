import type { DeviceBroadcaster } from "./broadcaster.js";
import type { DeviceSession } from "./deviceManager.js";
import type { ClientFrameStats } from "./protocol.js";
import { newPipelineStats } from "./pipelineStats.js";
import { StageResult, SelfTestReport, buildSelfTestReport, burstIntervals, formatReportForLog } from "./selfTestReport.js";

// Resolved next to the compiled module, so it works in Docker (/app) and in dev alike.
const PAGE_URL = new URL("../self-test/test1.html", import.meta.url).href;
const BINDING = "rwvSelfTest";

// How long the page must stay without new frames before a burst counts as fully sent.
const BURST_QUIET_MS = 150;
// Give up waiting for the device to catch up after a burst.
const BURST_DRAIN_TIMEOUT_MS = 10_000;

type PageEvent =
  | { type: "stage-start"; name: string; label: string; burst?: number }
  | { type: "step" }
  | { type: "burst-plan" }
  | { type: "stage-end"; name: string }
  | { type: "done" }
  | { type: "result-ready" };

// What the next client stats reply answers. The client replies in request order, and only
// after drawing every frame sent before the request. A step request carries its own
// timestamps: its reply may come after the page has given up waiting and moved on.
type Expected =
  | { kind: "reset" }
  | { kind: "drain" }
  | { kind: "step"; seq: number; stage: StageResult; stepStartMs: number; frameAtMs: number; sentAtMs: number };

type BurstState = {
  intervalMs: number;
  startMs: number;
  changesEndMs: number;  // the page's last change
  draining: boolean;
  pendingReplies: number;
  lastReplyMs: number;
  poll?: NodeJS.Timeout;
};

// The test page makes one change at a time and reports it through a CDP binding. The runner
// waits for the frame with that change to be sent, asks the client for its stats, and its
// reply confirms the frame was drawn: that's the change's latency. Only then does the page
// make the next change, so the device never has more than one frame in flight: frames queued
// on the device would add to the latency (and older clients without flow control can crash).
//
// The burst stages are the opposite: the page changes the whole screen on every browser frame,
// like scrolling, paced only by min_frame_interval. Each burst runs at a different interval
// (the configured one and the two estimates from the earlier stages), and its result is how
// far the device falls behind: the time from the last change until it confirms the last frame.
export class SelfTestRunner {
  private _broadcaster: DeviceBroadcaster;
  private _dev?: DeviceSession;
  private _bound = false;
  private _active = false;
  private _stage?: StageResult;
  private _results: StageResult[] = [];
  private _expected: Expected[] = [];
  private _stepSeq = 0;      // the step the page is waiting on
  private _stepStartMs = 0;
  private _awaitingFrame = false;
  private _burst?: BurstState;
  private _burstIntervals: number[] = [];
  private _report?: SelfTestReport;

  constructor(broadcaster: DeviceBroadcaster) {
    this._broadcaster = broadcaster;
  }

  public async startAsync(dev: DeviceSession): Promise<void> {
    this.stop();
    this._dev = dev;
    this._active = true;
    this._report = undefined;

    if (!this._bound) {
      dev.cdp.on("Runtime.bindingCalled", (evt: any) => {
        if (evt.name === BINDING) this._onPageEvent(evt.payload);
      });
      this._bound = true;
    }
    await dev.cdp.send("Runtime.enable");
    await dev.cdp.send("Runtime.addBinding", { name: BINDING });

    console.log(`[self-test] Started for device ${dev.deviceId}`);
    await dev.cdp.send("Page.navigate", { url: PAGE_URL });
  }

  public handleClientStats(stats: ClientFrameStats): void {
    const e = this._expected.shift();
    if (!e) return;
    if (e.kind === "drain" && this._burst) {
      this._burst.pendingReplies--;
      this._burst.lastReplyMs = Date.now();
      return;
    }
    if (e.kind !== "step") return;

    const now = Date.now();
    const deviceMs = stats.avgRenderMs;
    // Recorded even when late: the change really took that long.
    e.stage.steps.push({
      latencyMs: now - e.stepStartMs,
      // change on the page -> frame from the screencast (render + PNG encode + CDP)
      browserMs: Math.max(0, e.frameAtMs - e.stepStartMs),
      // waiting for the pipeline + decode, diff and JPEG encode
      serverMs: Math.max(0, e.sentAtMs - e.frameAtMs),
      // sent -> confirmed, minus the device's own decode and draw time
      networkMs: Math.max(0, now - e.sentAtMs - deviceMs),
      deviceMs,
    });
    // Only the step the page is waiting on may let it continue; a late reply must not end
    // the next step early.
    if (e.seq === this._stepSeq) this._continuePage();
  }

  public stop(): void {
    if (this._active) console.log(`[self-test] Stopped`);
    this._active = false;
    this._stage = undefined;
    this._results = [];
    this._expected = [];
    this._awaitingFrame = false;
    if (this._burst?.poll) clearTimeout(this._burst.poll);
    this._burst = undefined;
    if (this._dev) {
      this._dev.minFrameIntervalOverride = undefined;
      this._dev.onFrameSent = undefined;
    }
  }

  private _continuePage(value?: unknown): void {
    const arg = value === undefined ? "" : JSON.stringify(value);
    this._dev?.cdp.send("Runtime.evaluate", { expression: `window.rwvContinue && window.rwvContinue(${arg})` }).catch(() => { });
  }

  private _onFrameSent(frameAtMs: number, sentAtMs: number): void {
    if (!this._awaitingFrame || !this._dev || !this._stage) return;
    this._awaitingFrame = false;
    if (this._broadcaster.requestFrameStats(this._dev.deviceId))
      this._expected.push({ kind: "step", seq: this._stepSeq, stage: this._stage, stepStartMs: this._stepStartMs, frameAtMs, sentAtMs });
  }

  // Asks for client stats; the reply comes once the device has drawn everything sent so far.
  private _requestDrainConfirmation(): void {
    if (this._dev && this._burst && this._broadcaster.requestFrameStats(this._dev.deviceId)) {
      this._expected.push({ kind: "drain" });
      this._burst.pendingReplies++;
    }
  }

  // After the burst: every frame sent after the last change gets its own confirmation request,
  // so the last reply marks when the device drew the final state. Done once the server has
  // nothing left to send (no new frames for BURST_QUIET_MS) and all replies are in.
  private _pollBurstDrain(): void {
    const dev = this._dev;
    const b = this._burst;
    const stage = this._stage;
    if (!dev || !b || !stage) return;

    const now = Date.now();
    const idle = !dev.pendingB64 && !dev.processing && now - (dev.pendingAtMs ?? 0) >= BURST_QUIET_MS;
    const timedOut = now - b.changesEndMs > BURST_DRAIN_TIMEOUT_MS;
    if (!timedOut && !(idle && b.pendingReplies === 0)) {
      b.poll = setTimeout(() => this._pollBurstDrain(), 20);
      return;
    }

    const lastMs = timedOut ? now : b.lastReplyMs;
    stage.burst = {
      intervalMs: b.intervalMs,
      changesMs: b.changesEndMs - b.startMs,
      lagMs: Math.max(0, lastMs - b.changesEndMs),
      timedOut,
    };
    stage.server = { ...dev.stats };
    this._results.push(stage);
    this._stage = undefined;
    this._burst = undefined;
    dev.onFrameSent = undefined;
    dev.minFrameIntervalOverride = undefined;
    this._continuePage();
  }

  private _onPageEvent(payload: string): void {
    let evt: PageEvent;
    try { evt = JSON.parse(payload); } catch { return; }
    const dev = this._dev;
    if (!dev) return;

    if (evt.type === "result-ready") {
      if (this._report)
        dev.cdp.send("Runtime.evaluate", { expression: `window.rwvShowResult(${JSON.stringify(this._report)})` }).catch(() => { });
      return;
    }
    if (!this._active) return;

    switch (evt.type) {
      case "stage-start":
        // Reset the client's counters; that reply covers the time before the stage.
        if (this._broadcaster.requestFrameStats(dev.deviceId)) this._expected.push({ kind: "reset" });
        dev.stats = newPipelineStats();
        this._stage = { name: evt.name, label: evt.label, steps: [], server: dev.stats };
        if (evt.burst !== undefined) {
          // Paced by min_frame_interval like real scrolling, at the interval this burst tests.
          const intervalMs = this._burstIntervals[evt.burst] ?? dev.cfg.minFrameInterval;
          dev.minFrameIntervalOverride = intervalMs;
          this._burst = { intervalMs, startMs: Date.now(), changesEndMs: 0, draining: false, pendingReplies: 0, lastReplyMs: 0 };
          dev.onFrameSent = () => { if (this._burst?.draining) this._requestDrainConfirmation(); };
        } else {
          // One frame in flight at a time, so the interval would only add to the latency.
          dev.minFrameIntervalOverride = 0;
          dev.onFrameSent = (frameAtMs, sentAtMs) => this._onFrameSent(frameAtMs, sentAtMs);
        }
        console.log(`[self-test] Stage "${evt.label}" started` +
          (this._burst ? ` (min_frame_interval ${this._burst.intervalMs} ms)` : ""));
        break;

      case "burst-plan":
        // The page asks how many bursts to run; their intervals depend on the stages so far.
        this._burstIntervals = burstIntervals(this._results, dev.cfg.minFrameInterval);
        this._continuePage(this._burstIntervals.length);
        break;

      case "step":
        this._stepSeq++;
        this._stepStartMs = Date.now();
        this._awaitingFrame = true;
        break;

      case "stage-end":
        if (!this._stage || this._stage.name !== evt.name) return;
        if (this._burst) {
          this._burst.changesEndMs = Date.now();
          this._burst.lastReplyMs = this._burst.changesEndMs;
          this._burst.draining = true;
          // Covers the frames already sent; frames still to come request their own.
          this._requestDrainConfirmation();
          this._pollBurstDrain();
          return;
        }
        this._stage.server = { ...dev.stats };
        this._results.push(this._stage);
        this._stage = undefined;
        this._awaitingFrame = false;
        dev.minFrameIntervalOverride = undefined;
        dev.onFrameSent = undefined;
        break;

      case "done":
        this._finish();
        break;
    }
  }

  private _finish(): void {
    const dev = this._dev;
    if (!dev || !this._active) return;

    this._report = buildSelfTestReport(this._results, {
      minFrameInterval: dev.cfg.minFrameInterval,
      frameAcks: dev.acks.supported,
      maxBytesPerMessage: dev.cfg.maxBytesPerMessage,
      jpegQuality: dev.cfg.jpegQuality,
    });
    console.log(formatReportForLog(this._report));

    this._active = false;
    this._expected = [];
    dev.cdp.send("Page.navigate", { url: `${PAGE_URL}?view=result` })
      .catch(e => console.warn(`[self-test] Failed to show results: ${(e as Error).message}`));
  }
}
