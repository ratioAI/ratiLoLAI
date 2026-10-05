import type { Platform, Regional, SeedTier } from '@shared/types'
import { PLATFORMS } from '@shared/types'
import { describeKeyError } from './apiKey'
import { parseRateLimitHeader, RateLimiter } from './rateLimiter'
import type { AccountDTO, CurrentGameInfo, LeagueEntryDTO, LeagueListDTO, MasteryDTO, MatchDTO, SummonerDTO, TimelineDTO } from './types'

export class RiotApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** status.message from Riot's error body, if any */
    public readonly riotMessage: string | null = null
  ) {
    super(message)
    this.name = 'RiotApiError'
  }
}

export function regionalOf(platform: Platform): Regional {
  return PLATFORMS[platform].regional
}

/** "EUW1_7123456789" -> "euw1" */
export function platformOfMatchId(matchId: string): Platform | null {
  const p = matchId.split('_')[0]?.toLowerCase()
  return p && p in PLATFORMS ? (p as Platform) : null
}

type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>

export class RiotClient {
  /** Riot applies application rate limits per routing value (euw1, europe, ...). */
  private limiters = new Map<string, RateLimiter>()
  public requestCount = 0

  constructor(
    private readonly getKey: () => string | null,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  private limiter(host: string): RateLimiter {
    let l = this.limiters.get(host)
    if (!l) this.limiters.set(host, (l = new RateLimiter()))
    return l
  }

  async request<T>(host: string, path: string, opts: { allow404?: boolean; signal?: AbortSignal } = {}): Promise<T | null> {
    const key = this.getKey()
    if (!key) throw new RiotApiError(401, 'No Riot API key configured (Settings).')
    const limiter = this.limiter(host)

    for (let attempt = 0; attempt < 5; attempt++) {
      if (opts.signal?.aborted) throw new Error('aborted')
      await limiter.acquire()
      this.requestCount++
      let res: Response
      try {
        res = await this.fetchImpl(`https://${host}.api.riotgames.com${path}`, {
          headers: { 'X-Riot-Token': key },
          signal: opts.signal
        })
      } catch (e) {
        if (opts.signal?.aborted) throw e
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
        continue
      }

      const windows = parseRateLimitHeader(res.headers.get('x-app-rate-limit'))
      if (windows) limiter.setWindows(windows)

      if (res.ok) return (await res.json()) as T
      if (res.status === 404 && opts.allow404) return null
      if (res.status === 429) {
        const retry = Number(res.headers.get('retry-after') ?? 5)
        limiter.pause((Number.isFinite(retry) ? retry : 5) * 1000)
        continue
      }
      if (res.status >= 500) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
        continue
      }
      const riotMessage = await res
        .json()
        .then((b: { status?: { message?: string } }) => b?.status?.message ?? null)
        .catch(() => null)
      if (res.status === 401 || res.status === 403) {
        throw new RiotApiError(res.status, describeKeyError(res.status, riotMessage), riotMessage)
      }
      throw new RiotApiError(res.status, `Riot API error ${res.status} for ${path}${riotMessage ? ` (${riotMessage})` : ''}`, riotMessage)
    }
    throw new RiotApiError(503, `Riot API unreachable (${path})`)
  }

  // --- account / summoner -------------------------------------------------

  accountByRiotId(regional: Regional, gameName: string, tagLine: string): Promise<AccountDTO | null> {
    return this.request(regional, `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`, {
      allow404: true
    })
  }

  summonerByPuuid(platform: Platform, puuid: string): Promise<SummonerDTO | null> {
    return this.request(platform, `/lol/summoner/v4/summoners/by-puuid/${puuid}`, { allow404: true })
  }

  async leagueEntries(platform: Platform, puuid: string): Promise<LeagueEntryDTO[]> {
    return (await this.request<LeagueEntryDTO[]>(platform, `/lol/league/v4/entries/by-puuid/${puuid}`, { allow404: true })) ?? []
  }

  async topMastery(platform: Platform, puuid: string, count = 5): Promise<MasteryDTO[]> {
    return (
      (await this.request<MasteryDTO[]>(platform, `/lol/champion-mastery/v4/champion-masteries/by-puuid/${puuid}/top?count=${count}`, {
        allow404: true
      })) ?? []
    )
  }

  activeGame(platform: Platform, puuid: string): Promise<CurrentGameInfo | null> {
    return this.request(platform, `/lol/spectator/v5/active-games/by-summoner/${puuid}`, { allow404: true })
  }

  // --- leagues --------------------------------------------------------------

  async apexLeague(platform: Platform, tier: SeedTier, signal?: AbortSignal): Promise<LeagueListDTO | null> {
    const segment = { CHALLENGER: 'challengerleagues', GRANDMASTER: 'grandmasterleagues', MASTER: 'masterleagues' }[tier]
    return this.request(platform, `/lol/league/v4/${segment}/by-queue/RANKED_SOLO_5x5`, { allow404: true, signal })
  }

  // --- matches ----------------------------------------------------------------

  async matchIds(
    regional: Regional,
    puuid: string,
    q: { queue?: number; count?: number; start?: number; startTime?: number },
    signal?: AbortSignal
  ): Promise<string[]> {
    const params = new URLSearchParams()
    if (q.queue) params.set('queue', String(q.queue))
    params.set('count', String(q.count ?? 20))
    if (q.start) params.set('start', String(q.start))
    if (q.startTime) params.set('startTime', String(Math.floor(q.startTime / 1000)))
    return (
      (await this.request<string[]>(regional, `/lol/match/v5/matches/by-puuid/${puuid}/ids?${params}`, {
        allow404: true,
        signal
      })) ?? []
    )
  }

  match(regional: Regional, matchId: string, signal?: AbortSignal): Promise<MatchDTO | null> {
    return this.request(regional, `/lol/match/v5/matches/${matchId}`, { allow404: true, signal })
  }

  timeline(regional: Regional, matchId: string, signal?: AbortSignal): Promise<TimelineDTO | null> {
    return this.request(regional, `/lol/match/v5/matches/${matchId}/timeline`, { allow404: true, signal })
  }
}
