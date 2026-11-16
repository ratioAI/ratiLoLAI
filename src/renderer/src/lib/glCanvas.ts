/**
 * A new canvas inside `host` for one run of a WebGL effect, removed again by the effect's cleanup.
 * Every run needs its own canvas: a context released with loseContext() can't be used again, and in
 * development React runs each effect twice (StrictMode), which left the second run with a dead
 * context and a blank background.
 */
export function freshCanvas(host: HTMLElement, className = 'block h-full w-full'): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.className = className
  canvas.setAttribute('aria-hidden', 'true')
  host.append(canvas)
  return canvas
}

/** Name of the GPU WebGL runs on, e.g. "ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)". */
export function gpuName(gl: WebGLRenderingContext): string {
  const info = gl.getExtension('WEBGL_debug_renderer_info')
  return String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER))
}

/**
 * WebGL without a real GPU behind it: SwiftShader (Chromium's fallback, e.g. after the GPU process
 * crashed), llvmpipe, Microsoft's Basic Render Driver. Animations then cost a lot of CPU.
 */
export const isSoftwareGpu = (gpu: string): boolean => /swiftshader|llvmpipe|softpipe|software|basic render/i.test(gpu)
