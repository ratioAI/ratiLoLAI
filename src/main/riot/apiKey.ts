/** Removes whitespace, quotes and invisible characters that often sneak in when copying the key. */
export function sanitizeApiKey(raw: string): string {
  return raw.replace(/[\s"'`​-‍⁠﻿]/g, '')
}

const KEY_FORMAT = /^RGAPI-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isValidKeyFormat(key: string): boolean {
  return KEY_FORMAT.test(key)
}

/** Human readable explanation for a failed key check. */
export function describeKeyError(status: number, riotMessage: string | null): string {
  const detail = riotMessage ? ` – Riot: "${riotMessage}"` : ''
  switch (status) {
    case 401:
      return `Riot does not know this key (401). Did you copy all of it?${detail}`
    case 403:
      return `Key rejected (403). Development keys expire after 24 h – click "Regenerate API Key" in the developer portal and paste the new key.${detail}`
    case 429:
      return `Too many requests (429) – wait a moment and test again.${detail}`
    default:
      return `Riot API answered with status ${status}.${detail}`
  }
}
