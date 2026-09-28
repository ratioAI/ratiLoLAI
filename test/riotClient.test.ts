import { describe, expect, it, vi } from 'vitest'
import { platformOfMatchId, RiotApiError, RiotClient } from '../src/main/riot/client'

function res(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers })
}

describe('RiotClient', () => {
  it('sends the API key and parses JSON', async () => {
    const fetch = vi.fn(async () => res(200, { ok: 1 }, { 'x-app-rate-limit': '20:1,100:120' }))
    const client = new RiotClient(() => 'RGAPI-test', fetch)
    await expect(client.request('euw1', '/x')).resolves.toEqual({ ok: 1 })
    expect(fetch).toHaveBeenCalledWith('https://euw1.api.riotgames.com/x', expect.objectContaining({ headers: { 'X-Riot-Token': 'RGAPI-test' } }))
  })

  it('retries after a 429 response', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(res(429, {}, { 'retry-after': '0' }))
      .mockResolvedValueOnce(res(200, [1, 2]))
    const client = new RiotClient(() => 'k', fetch)
    await expect(client.request('europe', '/y')).resolves.toEqual([1, 2])
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('maps 404 to null when allowed', async () => {
    const client = new RiotClient(() => 'k', async () => res(404, {}))
    await expect(client.request('euw1', '/z', { allow404: true })).resolves.toBeNull()
  })

  it('throws a helpful error for invalid keys', async () => {
    const client = new RiotClient(() => 'k', async () => res(403, {}))
    await expect(client.request('euw1', '/z')).rejects.toBeInstanceOf(RiotApiError)
  })

  it('refuses to run without a key', async () => {
    const client = new RiotClient(() => null, async () => res(200, {}))
    await expect(client.request('euw1', '/z')).rejects.toThrow(/API key/)
  })
})

describe('platformOfMatchId', () => {
  it('extracts the platform', () => {
    expect(platformOfMatchId('EUW1_123')).toBe('euw1')
    expect(platformOfMatchId('KR_1')).toBe('kr')
    expect(platformOfMatchId('XX_1')).toBeNull()
  })
})
