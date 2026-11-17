import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { Readable } from 'node:stream'
import { parseClipUrl, parseRange } from '@shared/recorder'

/** What rcclip:// may serve at all: videos, pictures and sound. Never anything else, whatever the database says. */
export const MEDIA_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac'
}

export const mediaTypeOf = (file: string): string | null => MEDIA_TYPES[extname(file).toLowerCase()] ?? null

/**
 * A file as an HTTP-like response with byte ranges, so the video player can seek. Read-only;
 * anything that is not a media file is refused.
 */
export async function serveFile(file: string | null, rangeHeader: string | null): Promise<Response> {
  const type = file ? mediaTypeOf(file) : null
  if (!file || !type) return new Response('Not found', { status: 404 })
  const info = await stat(file).catch(() => null)
  if (!info?.isFile()) return new Response('Not found', { status: 404 })
  const range = parseRange(rangeHeader, info.size)
  if (range === 'invalid') return new Response('Range not satisfiable', { status: 416, headers: { 'Content-Range': `bytes */${info.size}` } })
  // readable by the window's own scripts too (the editor decodes the sound for the waveform and draws stickers)
  const headers: Record<string, string> = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' }
  if (!range) {
    headers['Content-Length'] = String(info.size)
    return new Response(info.size ? (Readable.toWeb(createReadStream(file)) as ReadableStream) : null, { status: 200, headers })
  }
  headers['Content-Length'] = String(range.end - range.start + 1)
  headers['Content-Range'] = `bytes ${range.start}-${range.end}/${info.size}`
  return new Response(Readable.toWeb(createReadStream(file, { start: range.start, end: range.end })) as ReadableStream, { status: 206, headers })
}

/**
 * Handler of the rcclip:// protocol. URLs carry ids only (rcclip://clip/12): the path comes from
 * the database or, for imported music and stickers, from a table of files the user picked. A page
 * can therefore never make it read an arbitrary path.
 */
export function clipProtocolHandler(lookup: (kind: 'clip' | 'thumb' | 'recording' | 'media', id: string) => string | null) {
  return async (request: { url: string; method?: string; headers: { get(name: string): string | null } }): Promise<Response> => {
    if (request.method && request.method !== 'GET' && request.method !== 'HEAD') return new Response('Read only', { status: 405 })
    const target = parseClipUrl(request.url)
    if (!target) return new Response('Not found', { status: 404 })
    return serveFile(lookup(target.kind, target.id), request.headers.get('range'))
  }
}
