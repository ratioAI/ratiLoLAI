import { describe, expect, it } from 'vitest'
import { describeKeyError, isValidKeyFormat, sanitizeApiKey } from '../src/main/riot/apiKey'

describe('API key helpers', () => {
  it('strips whitespace, quotes and invisible characters', () => {
    expect(sanitizeApiKey(' "RGAPI-12345678-abcd-abcd-abcd-123456789abc"\n​')).toBe('RGAPI-12345678-abcd-abcd-abcd-123456789abc')
  })
  it('validates the key format', () => {
    expect(isValidKeyFormat('RGAPI-12345678-abcd-abcd-abcd-123456789abc')).toBe(true)
    expect(isValidKeyFormat('RGAPI-123')).toBe(false)
  })
  it('explains 401 and 403 differently', () => {
    expect(describeKeyError(401, null)).toContain('401')
    expect(describeKeyError(403, 'Forbidden')).toContain('Regenerate')
  })
})
