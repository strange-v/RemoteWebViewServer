import { CDPSession } from "playwright-core";
import { DeviceBroadcaster } from "./broadcaster";

export class FpsTestRunner {
  private _stage = 0;
  private _partial?: number;
  private _full?: number;
  private _timeoutId0?: NodeJS.Timeout;
  private _timeoutId1?: NodeJS.Timeout;
  private _timeoutId2?: NodeJS.Timeout;

  public async startAsync(id: string, session: CDPSession, broadcaster: DeviceBroadcaster): Promise<void> {
    if (this._timeoutId0) clearTimeout(this._timeoutId0);
    if (this._timeoutId1) clearTimeout(this._timeoutId1);
    if (this._timeoutId2) clearTimeout(this._timeoutId2);

    await session.send('Page.navigate', { url: 'file:///app/fps-test/test1.html' });

    this._timeoutId0 = setTimeout(() => {
      this._stage = 0;
      console.log(`FPS test started for device ${id}`);
      broadcaster.startFpsMeasurement(id);
    }, 5_000);

    this._timeoutId1 = setTimeout(() => {
      this._stage = 1;
      console.log(`FPS test partial stage for device ${id}`);
      broadcaster.startFpsMeasurement(id);
    }, 70_000);

    this._timeoutId2 = setTimeout(() => {
      this._stage = 2;
      console.log(`FPS test full stage for device ${id}`);
      broadcaster.startFpsMeasurement(id);
    }, 125_000);
  }

  public async setFrameRenderTimeAsync(value: number, session: CDPSession): Promise<void> {
    switch (this._stage) {
      case 1:
        this._partial = value ?? 0;
        break;
      case 2:
        this._full = value ?? 0;
        console.log(`FPS test result: partial=${this._partial}ms, full=${this._full}ms`);
        await session.send('Page.navigate', { url: `file:///app/fps-test/test1.html?partial=${this._partial}&full=${this._full}` });
        break;
    }
  }

  public stop(): void {
    console.log(`FPS test stopped`);
    if (this._timeoutId0) clearTimeout(this._timeoutId0);
    if (this._timeoutId1) clearTimeout(this._timeoutId1);
    if (this._timeoutId2) clearTimeout(this._timeoutId2);
    this._timeoutId0 = undefined;
    this._timeoutId1 = undefined;
    this._timeoutId2 = undefined;
    this._stage = 0;
  }
}