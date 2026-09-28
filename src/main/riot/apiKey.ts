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
  const detail = riotMessage ? ` – Riot: „${riotMessage}“` : ''
  switch (status) {
    case 401:
      return `Riot kennt diesen Key nicht (401). Ist er vollständig kopiert?${detail}`
    case 403:
      return `Key abgelehnt (403). Development-Keys laufen nach 24 h ab – im Developer-Portal auf „Regenerate API Key“ klicken und den neuen Key eintragen.${detail}`
    case 429:
      return `Zu viele Anfragen (429) – kurz warten und erneut testen.${detail}`
    default:
      return `Riot API antwortet mit Status ${status}.${detail}`
  }
}
