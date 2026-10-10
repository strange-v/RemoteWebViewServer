import { describe, it, expect } from "vitest";
import { TouchKind, buildTouchPacket, parseTouchPacket } from "../src/protocol.js";

describe("parseTouchPacket", () => {
  it("accepts every defined touch kind", () => {
    for (const kind of [TouchKind.Down, TouchKind.Move, TouchKind.Up, TouchKind.Tap])
      expect(parseTouchPacket(buildTouchPacket(kind, 10, 20))).toEqual({ kind, pointerId: 0, x: 10, y: 20 });
  });

  it("rejects unknown kinds", () => {
    expect(parseTouchPacket(buildTouchPacket(TouchKind.Unknown, 1, 1))).toBeNull();
    expect(parseTouchPacket(buildTouchPacket(5 as TouchKind, 1, 1))).toBeNull();
  });
});
