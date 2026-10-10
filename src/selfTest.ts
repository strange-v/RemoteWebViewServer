import type { DeviceBroadcaster } from "./broadcaster.js";
import type { DeviceSession } from "./deviceManager.js";
import type { ClientFrameStats } from "./protocol.js";
import { newPipelineStats } from "./pipelineStats.js";
import { StageResult, SelfTestReport, buildSelfTestReport, formatReportForLog } from "./selfTestReport.js";

// Resolved next to the compiled module, so it works in Docker (/app) and in dev alike.
const PAGE_URL = new URL("../self-test/test1.html", import.meta.url).href;
const BINDING = "rwvSelfTest";

type PageEvent =
  | { type: "stage-start"; name: string; label: string }
  | { type: "step" }
  | { type: "stage-end"; name: string }
  | { type: "done" }
  | { type: "result-ready" };

// What the next client stats reply answers. The client replies in request order, and only
// after drawing every frame sent before the request.
type Expected = "reset" | "step";

// The test page makes one change at a time and reports it through a CDP binding. The runner
// waits for the frame with that change to be sent, asks the client for its stats, and its
// reply confirms the frame was drawn: that's the change's latency. Only then does the page
// make the next change, so the device never has more than one frame in flight: frames queued
// on the device would add to the latency (and older clients without flow control can crash).
export class SelfTestRunner {
  private _broadcaster: DeviceBroadcaster;
  private _dev?: DeviceSession;
  private _bound = false;
  private _active = false;
  private _stage?: StageResult;
  private _results: StageResult[] = [];
  private _expected: Expected[] = [];
  private _stepStartMs = 0;
  private _awaitingFrame = false;
  // timestamps of the current step's frame: arrived from the browser, handed to the socket
  private _frameAtMs = 0;
  private _sentAtMs = 0;
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
    const kind = this._expected.shift();
    if (kind !== "step" || !this._stage) return;
    const now = Date.now();
    const deviceMs = stats.avgRenderMs;
    this._stage.steps.push({
      latencyMs: now - this._stepStartMs,
      // change on the page -> frame from the screencast (render + PNG encode + CDP)
      browserMs: Math.max(0, this._frameAtMs - this._stepStartMs),
      // waiting for the pipeline + decode, diff and JPEG encode
      serverMs: Math.max(0, this._sentAtMs - this._frameAtMs),
      // sent -> confirmed, minus the device's own decode and draw time
      networkMs: Math.max(0, now - this._sentAtMs - deviceMs),
      deviceMs,
    });
    this._continuePage();
  }

  public stop(): void {
    if (this._active) console.log(`[self-test] Stopped`);
    this._active = false;
    this._stage = undefined;
    this._results = [];
    this._expected = [];
    this._awaitingFrame = false;
    if (this._dev) {
      this._dev.minFrameIntervalOverride = undefined;
      this._dev.onFrameSent = undefined;
    }
  }

  private _continuePage(): void {
    this._dev?.cdp.send("Runtime.evaluate", { expression: "window.rwvContinue && window.rwvContinue()" }).catch(() => { });
  }

  private _onFrameSent(frameAtMs: number, sentAtMs: number): void {
    if (!this._awaitingFrame || !this._dev) return;
    this._awaitingFrame = false;
    this._frameAtMs = frameAtMs;
    this._sentAtMs = sentAtMs;
    if (this._broadcaster.requestFrameStats(this._dev.deviceId)) this._expected.push("step");
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
        if (this._broadcaster.requestFrameStats(dev.deviceId)) this._expected.push("reset");
        dev.stats = newPipelineStats();
        // One frame in flight at a time, so the interval would only add to the latency.
        dev.minFrameIntervalOverride = 0;
        dev.onFrameSent = (frameAtMs, sentAtMs) => this._onFrameSent(frameAtMs, sentAtMs);
        this._stage = { name: evt.name, label: evt.label, steps: [], server: dev.stats };
        console.log(`[self-test] Stage "${evt.label}" started`);
        break;

      case "step":
        this._stepStartMs = Date.now();
        this._awaitingFrame = true;
        break;

      case "stage-end":
        if (!this._stage || this._stage.name !== evt.name) return;
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
