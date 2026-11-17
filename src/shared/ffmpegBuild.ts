/**
 * The FFmpeg build the recorder downloads on first use (never part of the installer, never linked
 * into the app: it runs as its own program).
 *
 * It must be an LGPL build (no x264, x265 or other GPL parts) of FFmpeg 8.1 or newer for Windows
 * x64 with nvenc, amf and qsv (libvpl): 8.1 is the first version with gfxcapture (Windows Graphics
 * Capture). The archive is one of this repository's own release assets, so the app always gets the
 * exact file whose SHA-256 is written down here.
 *
 * To publish a new build: upload the zip to a release of this repository that is marked as a
 * pre-release (so the auto updater never mistakes it for an app release), then put its URL, size
 * and SHA-256 here.
 */
export const FFMPEG_BUILD = {
  version: '8.1',
  url: 'https://github.com/ratioAI/ratiLoLAI/releases/download/ffmpeg-8.1-lgpl/ffmpeg-8.1-win64-lgpl.zip',
  /** hex SHA-256 of the zip; empty until the asset is published (the download is refused then) */
  sha256: '7947012ff7ef4fdc8b459186b456716bc2941ac41c8118f128e0a840a97b6646',
  /** size in bytes, for the progress bar when the server sends no length */
  bytes: 167576152,
  license: 'LGPL-2.1-or-later',
  licenseUrl: 'https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html',
  /** where the build and its source come from */
  sourceUrl: 'https://github.com/BtbN/FFmpeg-Builds',
  upstreamUrl: 'https://ffmpeg.org/download.html'
} as const

/** true once a real asset (64 hex digits) is written down above */
export const ffmpegBuildPublished = (build: { sha256: string } = FFMPEG_BUILD): boolean => /^[0-9a-f]{64}$/i.test(build.sha256)
