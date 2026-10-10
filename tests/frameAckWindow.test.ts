import { describe, it, expect } from "vitest";
import { FrameAckWindow } from "../src/frameAckWindow.js";

describe("FrameAckWindow", () => {
  it("doesn't limit clients that never ack", () => {
    const w = new FrameAckWindow(2);
    for (let id = 1; id <= 10; id++) w.sent(id, 0);
    expect(w.supported).toBe(false);
    expect(w.isFull(0)).toBe(false);
  });

  it("keeps at most `size` frames in flight once the client acks", () => {
    const w = new FrameAckWindow(2);
    w.sent(1, 0);
    expect(w.ack(1)).toBe(true);
    expect(w.supported).toBe(true);
    w.sent(2, 10);
    expect(w.isFull(10)).toBe(false);
    w.sent(3, 20);
    expect(w.isFull(20)).toBe(true);
    expect(w.ack(2)).toBe(true);
    expect(w.isFull(30)).toBe(false);
    expect(w.inFlight).toBe(1);
  });

  it("counts the backlog sent before the first ack", () => {
    const w = new FrameAckWindow(2);
    for (let id = 1; id <= 10; id++) w.sent(id, 0);
    w.ack(1);
    expect(w.inFlight).toBe(9);
    expect(w.isFull(0)).toBe(true); // nothing more until the device works through it
    w.ack(9);
    expect(w.isFull(0)).toBe(false);
  });

  it("remembers a bounded number of frames for clients that never ack", () => {
    const w = new FrameAckWindow(2);
    for (let id = 1; id <= 1000; id++) w.sent(id, 0);
    expect(w.inFlight).toBe(64);
  });

  it("treats acks as cumulative", () => {
    const w = new FrameAckWindow(3);
    w.ack(0);
    w.sent(1, 0); w.sent(2, 0); w.sent(3, 0);
    w.ack(2); // frame 1's own ack was lost or the device dropped its last packet
    expect(w.inFlight).toBe(1);
  });

  it("handles frame ids wrapping around u32", () => {
    const w = new FrameAckWindow(3);
    w.ack(0xffff_fffe);
    w.sent(0xffff_ffff, 0); w.sent(0, 0); w.sent(1, 0);
    w.ack(0);
    expect(w.inFlight).toBe(1); // only frame 1 is left
  });

  it("gives up on frames unacknowledged for longer than the timeout", () => {
    const w = new FrameAckWindow(2, 1000);
    w.ack(0);
    w.sent(1, 0); w.sent(2, 100);
    expect(w.isFull(900)).toBe(true);
    expect(w.timeoutAtMs()).toBe(1000);
    expect(w.isFull(1001)).toBe(false);
    expect(w.inFlight).toBe(0);
  });

  it("forgets everything on reset", () => {
    const w = new FrameAckWindow(1);
    w.ack(0); w.sent(1, 0);
    w.reset();
    expect(w.supported).toBe(false);
    expect(w.isFull(0)).toBe(false);
  });
});
