'use client'

import { useEffect, useState } from 'react'
import type { DashboardData } from '../widget-primitives'

type OverviewPayload = {
  generatedAt: number
  gateway: {
    host: string
    port: number
    authMode: string
    reachable: boolean
    connectedChannels: number
    configuredChannels: number
    channels: Array<{
      key: string
      label: string
      configured: boolean
      running: boolean
      connected: boolean
      accounts: number
      lastInboundAt: number | null
      lastError: string | null
    }>
  }
  sessions: {
    total: number
    active: number
    discord: number
    recent: Array<{
      id: string
      key: string
      agent: string
      channel: string
      kind: string
      model: string
      active: boolean
      updatedAt: number
      totalTokens: number
    }>
  }
  tasks: {
    total: number
    active: number
    byStatus: Record<string, number>
  }
  discordActivity: Array<{
    id: string
    ts: number
    agent: string
    sessionKey: string
    role: string
    excerpt: string
  }>
  omx: {
    projectPath: string
    teams: Array<{
      teamName: string
      workerCount: number
      tasks: {
        pending: number
        in_progress: number
        blocked: number
        completed: number
        failed: number
        total: number
      }
      workers: Array<{
        name: string
        alive: boolean
        lastTurnAt: string | null
        turnsWithoutProgress: number
      }>
    }>
  }
}

function relativeTime(ts: number | null | undefined): string {
  if (!ts) return 'n/a'
  const diff = Math.max(0, Date.now() - ts)
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function SectionTitle({ title, meta }: { title: string; meta?: string }) {
  return (
    <div className="flex items-center justify-between">
      <h4 className="text-xs font-semibold uppercase text-muted-foreground">{title}</h4>
      {meta ? <span className="text-2xs text-muted-foreground font-mono-tight">{meta}</span> : null}
    </div>
  )
}

export function OpenClawMissionControlWidget(_: { data: DashboardData }) {
  const [payload, setPayload] = useState<OverviewPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      try {
        const res = await fetch('/api/openclaw/mission-control', { cache: 'no-store' })
        if (!res.ok) throw new Error(`Request failed (${res.status})`)
        const data = await res.json()
        if (!cancelled) {
          setPayload(data)
          setError(null)
        }
      } catch (err: any) {
        if (!cancelled) setError(err?.message || 'Failed to load overview')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    const interval = window.setInterval(load, 15000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [])

  return (
    <div className="panel">
      <div className="panel-header">
        <div>
          <h3 className="text-sm font-semibold">Mission Control Overview</h3>
          <p className="text-2xs text-muted-foreground mt-1">
            Live OpenClaw gateway and channel state, active sessions, task load, recent Discord activity, and OMX team progress.
          </p>
        </div>
        <div className="text-right">
          <div className="text-2xs uppercase text-muted-foreground">Updated</div>
          <div className="text-xs font-mono-tight text-foreground">{relativeTime(payload?.generatedAt)}</div>
        </div>
      </div>

      {loading && !payload ? (
        <div className="panel-body text-xs text-muted-foreground">Loading live Mission Control overview...</div>
      ) : error && !payload ? (
        <div className="panel-body text-xs text-red-400">{error}</div>
      ) : payload ? (
        <div className="panel-body space-y-6">
          <div className="grid gap-4 xl:grid-cols-4">
            <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/8 p-4">
              <div className="text-2xs uppercase text-emerald-200/80">Gateway</div>
              <div className="mt-2 text-xl font-semibold text-foreground">
                {payload.gateway.reachable ? 'Reachable' : 'Unavailable'}
              </div>
              <div className="mt-1 text-xs text-muted-foreground font-mono-tight">
                {payload.gateway.host}:{payload.gateway.port} · auth {payload.gateway.authMode}
              </div>
            </div>
            <div className="rounded-lg border border-sky-500/20 bg-sky-500/8 p-4">
              <div className="text-2xs uppercase text-sky-200/80">Channels</div>
              <div className="mt-2 text-xl font-semibold text-foreground">
                {payload.gateway.connectedChannels}/{payload.gateway.configuredChannels}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">connected vs configured</div>
            </div>
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/8 p-4">
              <div className="text-2xs uppercase text-amber-200/80">Sessions</div>
              <div className="mt-2 text-xl font-semibold text-foreground">
                {payload.sessions.active}/{payload.sessions.total}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">{payload.sessions.discord} Discord session(s)</div>
            </div>
            <div className="rounded-lg border border-fuchsia-500/20 bg-fuchsia-500/8 p-4">
              <div className="text-2xs uppercase text-fuchsia-200/80">Tasks</div>
              <div className="mt-2 text-xl font-semibold text-foreground">
                {payload.tasks.active}/{payload.tasks.total}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">assigned, in progress, or under review</div>
            </div>
          </div>

          <div className="grid gap-4 xl:grid-cols-[1.25fr_1fr_1fr]">
            <section className="space-y-3">
              <SectionTitle title="Channel Status" meta={`${payload.gateway.channels.length} channels`} />
              <div className="space-y-2">
                {payload.gateway.channels.slice(0, 6).map((channel) => (
                  <div key={channel.key} className="rounded-lg border border-border/60 bg-card/40 px-3 py-2.5">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-xs font-medium text-foreground">{channel.label}</div>
                        <div className="text-2xs text-muted-foreground">
                          {channel.accounts} account(s) · last traffic {relativeTime(channel.lastInboundAt)}
                        </div>
                      </div>
                      <div className={`text-2xs font-semibold ${channel.connected ? 'text-emerald-300' : channel.running ? 'text-amber-300' : 'text-rose-300'}`}>
                        {channel.connected ? 'Connected' : channel.running ? 'Running' : 'Offline'}
                      </div>
                    </div>
                    {channel.lastError ? (
                      <div className="mt-2 text-2xs text-rose-300 line-clamp-2">{channel.lastError}</div>
                    ) : null}
                  </div>
                ))}
              </div>
            </section>

            <section className="space-y-3">
              <SectionTitle title="Recent Sessions" meta={`${payload.sessions.recent.length} shown`} />
              <div className="space-y-2">
                {payload.sessions.recent.map((session) => (
                  <div key={session.id} className="rounded-lg border border-border/60 bg-card/40 px-3 py-2.5">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-xs font-medium text-foreground truncate">{session.agent}</div>
                        <div className="text-2xs text-muted-foreground">
                          {session.channel} · {session.kind} · {session.model.split('/').pop()}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className={`text-2xs font-semibold ${session.active ? 'text-emerald-300' : 'text-muted-foreground'}`}>
                          {session.active ? 'Active' : 'Idle'}
                        </div>
                        <div className="text-2xs text-muted-foreground">{relativeTime(session.updatedAt)}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="space-y-3">
              <SectionTitle title="OMX Teams" meta={payload.omx.projectPath} />
              <div className="space-y-2">
                {payload.omx.teams.length === 0 ? (
                  <div className="rounded-lg border border-border/60 bg-card/40 px-3 py-3 text-xs text-muted-foreground">
                    No OMX team state found under this project yet.
                  </div>
                ) : payload.omx.teams.map((team) => (
                  <div key={team.teamName} className="rounded-lg border border-border/60 bg-card/40 px-3 py-2.5">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-xs font-medium text-foreground">{team.teamName}</div>
                        <div className="text-2xs text-muted-foreground">{team.workerCount} workers</div>
                      </div>
                      <div className="text-right text-2xs text-muted-foreground">
                        <div>{team.tasks.in_progress} active</div>
                        <div>{team.tasks.pending} pending</div>
                      </div>
                    </div>
                    <div className="mt-2 flex gap-2 text-2xs text-muted-foreground">
                      <span>blocked {team.tasks.blocked}</span>
                      <span>done {team.tasks.completed}</span>
                      <span>failed {team.tasks.failed}</span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>

          <section className="space-y-3">
            <SectionTitle title="Recent Discord Activity" meta={`${payload.discordActivity.length} events`} />
            <div className="grid gap-2 xl:grid-cols-2">
              {payload.discordActivity.length === 0 ? (
                <div className="rounded-lg border border-border/60 bg-card/40 px-3 py-3 text-xs text-muted-foreground">
                  No recent Discord transcript events were found in gateway session history.
                </div>
              ) : payload.discordActivity.map((event) => (
                <div key={event.id} className="rounded-lg border border-border/60 bg-card/40 px-3 py-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-xs font-medium text-foreground">{event.agent}</div>
                    <div className="text-2xs text-muted-foreground">{event.role} · {relativeTime(event.ts)}</div>
                  </div>
                  <div className="mt-1 text-xs text-foreground/85 line-clamp-3">{event.excerpt}</div>
                </div>
              ))}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  )
}
