import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Snapshot, View } from '../types'

type SpendLine = { text: string; color: 'success' | 'warning' | 'error' | 'subtle' }

type Pace = { low: number; high: number; isWorkday: boolean; day: number; workdays: number }

type Config = { quota: number; daysOff: Set<number> }

type ExtraUsage = {
  monthly_limit?: number
  used_credits?: number
  decimal_places?: number
}

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const SHOWN_MS = 10_000
const MIN_FETCH_MS = 60_000
const BACKOFF_MS = 5 * 60_000
const LAST_GOOD_KEY = 'lastGood'
const BLOCKED_KEY = 'blockedUntil'
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const VERDICT_COLORS: Record<string, SpendLine['color']> = {
  '▼': 'success',
  '●': 'warning',
  '▲': 'error',
}

const latest = atom({ plugin: 'spend-quota', key: 'snapshot' } as const, null)
const shown = atom({ plugin: 'spend-quota', key: 'shown' } as const, null)

let hideTimer: Timer | undefined

const group = (n: number) => Math.round(n).toLocaleString('en-US')

const usd = (n: number) => `$${group(n)}`

function parseDaysOff(text: string): Set<number> {
  const off = new Set<number>()
  for (const name of text.split(',')) {
    const prefix = name.trim().slice(0, 3).toLowerCase()
    const i = WEEKDAYS.findIndex(w => w.toLowerCase() === prefix)
    if (i >= 0) off.add(i)
  }
  return off.size === 7 ? new Set() : off
}

function paceFor(now: Date, quota: number, daysOff: Set<number>): Pace {
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  const isWorkday = (day: number) =>
    !daysOff.has(new Date(now.getFullYear(), now.getMonth(), day).getDay())

  let workdays = 0
  let before = 0
  for (let day = 1; day <= daysInMonth; day++) {
    if (!isWorkday(day)) continue
    workdays++
    if (day < now.getDate()) before++
  }

  const isToday = isWorkday(now.getDate())
  const perDay = quota / workdays
  const day = before + (isToday ? 1 : 0)
  return { low: perDay * before, high: perDay * day, isWorkday: isToday, day, workdays }
}

function verdict(spent: number, pace: Pace): string {
  if (spent < pace.low) return `▼ ${usd(pace.low - spent)} under`
  if (spent > pace.high) return `▲ ${usd(spent - pace.high)} over`
  return '● on pace'
}

function spendLine(spent: number, quota: number, pace: Pace): SpendLine {
  const day = `${pace.isWorkday ? 'day' : 'off'} ${pace.day}/${pace.workdays}`
  const text = `${usd(spent)}/${group(quota)} · ${day} · expected ${usd(pace.high)}`

  if (spent < pace.low) return { text, color: 'success' }
  if (spent > pace.high) return { text, color: 'error' }
  return { text, color: 'warning' }
}

function reportText(snapshot: Snapshot, now: Date, cfg: Config): string {
  if (!snapshot.ok) return `Spend unavailable: ${snapshot.reason}`

  const { spent, quota } = snapshot
  const pace = paceFor(now, quota, cfg.daysOff)
  const today = pace.isWorkday
    ? `${usd(pace.low)}–${usd(pace.high)} expected today`
    : `day off, ${usd(pace.low)} expected`
  const ageMinutes = Math.floor((now.getTime() - snapshot.at) / 60_000)
  const age = ageMinutes < 1 ? '<1m' : `${ageMinutes}m`
  const updated = snapshot.isCached ? ` · updated ${age} ago` : ''
  return [
    `This month: ${usd(spent)} of ${usd(quota)} (${Math.round((spent / quota) * 100)}%)${updated}`,
    `Day:        ${pace.isWorkday ? '' : 'off, '}${pace.day}/${pace.workdays}`,
    `Today:      ${today} · ${verdict(spent, pace)}`,
    `Days off:   ${[...cfg.daysOff].map(i => WEEKDAYS[i]).join(', ') || 'none'}`,
  ].join('\n')
}

async function fetchSnapshot($: EngineInterface, cfg: Config, now: number): Promise<Snapshot> {
  const auth = await $.session.authorize()
  if (!auth) return { ok: false, reason: 'no first-party login' }

  const res = await $.http.fetch(USAGE_URL, {
    auth: auth.handle,
    headers: { accept: 'application/json', 'anthropic-beta': 'oauth-2025-04-20' },
  })
  if (res.status === 429) {
    const seconds = Number(res.headers['retry-after'])
    const retryAfterMs = Number.isFinite(seconds) ? Math.max(MIN_FETCH_MS, seconds * 1000) : BACKOFF_MS
    return { ok: false, reason: 'rate limited by the usage endpoint', retryAfterMs }
  }
  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}: ${res.text.slice(0, 200)}` }

  const extra = (JSON.parse(res.text) as { extra_usage?: ExtraUsage | null }).extra_usage
  if (typeof extra?.used_credits !== 'number') {
    return { ok: false, reason: `no extra_usage in response: ${res.text.slice(0, 300)}` }
  }

  const unit = 10 ** (extra.decimal_places ?? 2)
  const limit = extra.monthly_limit ? extra.monthly_limit / unit : cfg.quota
  return { ok: true, spent: extra.used_credits / unit, quota: limit, at: now }
}

// The usage endpoint rate-limits: reuse the last good reading for a minute, while backing off, and on failure.
async function loadSnapshot($: EngineInterface, cfg: Config): Promise<Snapshot> {
  const now = await $.clock.now()
  const stored = (await $.store.get(LAST_GOOD_KEY)) as Snapshot | undefined
  const blockedUntil = Number((await $.store.get(BLOCKED_KEY)) ?? 0)
  if (stored?.ok && (now - stored.at < MIN_FETCH_MS || now < blockedUntil)) {
    return { ...stored, isCached: true }
  }

  const fetched = await fetchSnapshot($, cfg, now).catch(
    (err): Snapshot => ({ ok: false, reason: String(err) }),
  )
  if (fetched.ok) {
    await $.store.set(LAST_GOOD_KEY, fetched)
    return fetched
  }
  if (fetched.retryAfterMs) await $.store.set(BLOCKED_KEY, now + fetched.retryAfterMs)
  return stored?.ok ? { ...stored, isCached: true } : fetched
}

async function hide($: EngineInterface) {
  await update($, shown, () => null)
}

async function flash($: EngineInterface, cfg: Config, view: View) {
  hideTimer?.cancel()
  const snapshot = await loadSnapshot($, cfg)
  await update($, latest, () => snapshot)
  await update($, shown, () => view)
  hideTimer = $.clock.after(SHOWN_MS, () => void hide($))
}

async function scheduleHourly($: EngineInterface, cfg: Config) {
  const now = new Date(await $.clock.now())
  const nextHour = new Date(now)
  nextHour.setHours(now.getHours() + 1, 0, 0, 0)

  $.clock.after(nextHour.getTime() - now.getTime(), () => {
    void flash($, cfg, 'line')
    void scheduleHourly($, cfg)
  })
}

export const register: Register = (on, options) => {
  const cfg: Config = {
    quota: Number(options.monthlyQuota),
    daysOff: parseDaysOff(String(options.daysOff)),
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'spend',
      description: 'Show month spend for 10 seconds',
      immediate: true,
    })
    await scheduleHourly($, cfg)
    return next(e)
  })

  on('command.run', { command: 'spend' }, async $ => {
    await flash($, cfg, 'report')
    return {}
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const snapshot = await read($, latest)
    const view = await read($, shown)
    if (e.props.hasSurvey || snapshot === null || view === null) return next(e)

    const now = new Date(await $.clock.now())
    const { Box, Text } = $.ui.resolve(e)

    if (view === 'report') {
      return (
        <Box flexDirection="column">
          <Text> </Text>
          {reportText(snapshot, now, cfg)
            .split('\n')
            .map((line, i) => {
              const [head, tail] = line.split(' · ')
              const color = tail ? VERDICT_COLORS[tail.charAt(0)] : undefined
              return (
                <Text key={String(i)}>
                  {color ? head + ' · ' : line}
                  {color && <Text color={color}>{tail}</Text>}
                </Text>
              )
            })}
        </Box>
      )
    }

    const current: SpendLine = snapshot.ok
      ? spendLine(snapshot.spent, snapshot.quota, paceFor(now, snapshot.quota, cfg.daysOff))
      : { text: 'spend n/a (/spend)', color: 'subtle' }

    return (
      <Box>
        <Text color={current.color}>{current.text}</Text>
      </Box>
    )
  })
}
