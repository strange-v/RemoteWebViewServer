// Per-device counters of the frame pipeline, reset by the self-test at stage boundaries.
export type PipelineStats = {
  framesSent: number;
  fullFrames: number;
  bytesSent: number;
  rects: number;
  maxRectBytes: number;
  procMsTotal: number;      // PNG decode + diff + JPEG encode
  procMsMax: number;
};

export function newPipelineStats(): PipelineStats {
  return {
    framesSent: 0,
    fullFrames: 0,
    bytesSent: 0,
    rects: 0,
    maxRectBytes: 0,
    procMsTotal: 0,
    procMsMax: 0,
  };
}
