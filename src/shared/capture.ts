/** Messages between the main process and the hidden capture page. */

/** Region of a screen as fractions (0-1) of the frame, optionally scaled to outW x outH pixels. */
export interface CaptureRegion {
  x: number
  y: number
  w: number
  h: number
  outW?: number
  outH?: number
}

export type CaptureCommand =
  | { type: 'open'; streams: { displayId: number; sourceId: string; width: number; height: number; fps: number }[] }
  | { type: 'close' }
  | { type: 'grab'; displayId: number; regions: CaptureRegion[] }

export interface CaptureFrame {
  width: number
  height: number
  /** RGBA */
  data: Uint8Array
}

export interface CaptureReply {
  ok: boolean
  error?: string
  frameWidth?: number
  frameHeight?: number
  /** ms since the frame was captured, a large value means the stream stalled */
  frameAge?: number
  frames?: CaptureFrame[]
}

export interface CaptureBridge {
  onCommand(listener: (id: number, command: CaptureCommand) => void): void
  reply(id: number, reply: CaptureReply): void
}

declare global {
  interface Window {
    rcCapture?: CaptureBridge
  }
}
