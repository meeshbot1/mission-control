import { NextRequest, NextResponse } from 'next/server'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { requireRole } from '@/lib/auth'
import { getDatabase } from '@/lib/db'
import { config } from '@/lib/config'
import { runCommand, runOpenClaw } from '@/lib/command'
import { callOpenClawGateway, parseGatewayJsonOutput } from '@/lib/openclaw-gateway'
import { getDetectedGatewayPort, getDetectedGatewayToken } from '@/lib/gateway-runtime'
import { getAllGatewaySessions, type GatewaySession } from '@/lib/sessions'
import { parseJsonlTranscript, readSessionJsonl } from '@/lib/transcript-parser'
import { logger } from '@/lib/logger'

type ChannelSnapshot = {
  key: string
  label: string
  configured: boolean
  running: boolean
  connected: boolean
  accounts: number
  lastInboundAt: number | null
  lastError: string | null
}

type DiscordActivity = {
  id: string
  ts: number
  agent: string
  sessionKey: string
  role: 'user' | 'assistant' | 'system'
  excerpt: string
}

type OmxTeamSummary = {
  projectPath: string
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
}

type OmxProjectSummary = {
  projectPath: string
  teams: OmxTeamSummary[]
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function readBool(value: unknown): boolean {
  return value === true
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

async function loadChannelsSnapshot(): Promise<{ channels: ChannelSnapshot[]; updatedAt: number | null }> {
  let payload: unknown = null

  try {
    payload = await callOpenClawGateway('channels.status', { probe: false, timeoutMs: 5000 }, 8000)
  } catch {
    try {
      const { stdout } = await runOpenClaw(['channels', 'status', '--json', '--timeout', '5000'], { timeoutMs: 10000 })
      payload = parseGatewayJsonOutput(stdout)
    } catch (error) {
      logger.warn({ err: error }, 'Failed to load OpenClaw channel status')
    }
  }

  const parsed = asRecord(payload) ?? {}
  const rawChannels = asRecord(parsed.channels) ?? {}
  const rawAccounts = asRecord(parsed.channelAccounts) ?? {}
  const rawLabels = asRecord(parsed.channelLabels) ?? {}
  const order = Array.isArray(parsed.channelOrder)
    ? parsed.channelOrder.filter((value): value is string => typeof value === 'string')
    : Object.keys(rawChannels)

  const channels: ChannelSnapshot[] = order.map((key) => {
    const channel = asRecord(rawChannels[key]) ?? {}
    const accountsValue = rawAccounts[key]
    const accountsRecord = asRecord(accountsValue)
    const accounts = Array.isArray(accountsValue)
      ? accountsValue
      : accountsRecord
        ? Object.values(accountsRecord)
        : []
    const accountRecords = accounts.map((entry) => asRecord(entry) ?? {})
    const lastInboundAt = accountRecords.reduce<number | null>((latest, account) => {
      const candidate = readNumber(account.lastInboundAt) ?? readNumber(account.lastOutboundAt) ?? readNumber(account.lastConnectedAt)
      return candidate != null && (latest == null || candidate > latest) ? candidate : latest
    }, null)
    const lastError = readString(channel.lastError) ?? accountRecords.map((account) => readString(account.lastError)).find(Boolean) ?? null

    return {
      key,
      label: readString(rawLabels[key]) ?? key,
      configured: readBool(channel.configured) || accountRecords.some((account) => readBool(account.configured)),
      running: readBool(channel.running) || accountRecords.some((account) => readBool(account.running)),
      connected: readBool(channel.connected) || accountRecords.some((account) => readBool(account.connected)),
      accounts: accountRecords.length,
      lastInboundAt,
      lastError,
    }
  })

  return {
    channels,
    updatedAt: readNumber(parsed.ts),
  }
}

async function loadGatewayHealth() {
  const port = getDetectedGatewayPort() || config.gatewayPort
  const hasToken = Boolean(getDetectedGatewayToken())
  const channels = await loadChannelsSnapshot()
  const connectedCount = channels.channels.filter((channel) => channel.connected).length

  return {
    host: config.gatewayHost,
    port,
    authMode: hasToken ? 'token' : 'none-detected',
    reachable: channels.channels.length > 0,
    connectedChannels: connectedCount,
    configuredChannels: channels.channels.filter((channel) => channel.configured).length,
    updatedAt: channels.updatedAt,
    channels: channels.channels,
  }
}

function loadTaskSummary(workspaceId: number) {
  const db = getDatabase()
  const rows = db.prepare(
    'SELECT status, COUNT(*) as count FROM tasks WHERE workspace_id = ? GROUP BY status'
  ).all(workspaceId) as Array<{ status: string; count: number }>

  const byStatus: Record<string, number> = {}
  let total = 0
  for (const row of rows) {
    byStatus[row.status] = row.count
    total += row.count
  }

  return {
    total,
    byStatus,
    active: (byStatus.assigned || 0) + (byStatus.in_progress || 0) + (byStatus.review || 0) + (byStatus.quality_review || 0),
  }
}

function summarizeSessions(sessions: GatewaySession[]) {
  const byChannel = sessions.reduce<Record<string, number>>((acc, session) => {
    const key = session.channel || 'unknown'
    acc[key] = (acc[key] || 0) + 1
    return acc
  }, {})

  return {
    total: sessions.length,
    active: sessions.filter((session) => session.active).length,
    discord: sessions.filter((session) => session.channel === 'discord').length,
    byChannel,
    recent: sessions.slice(0, 8).map((session) => ({
      id: session.sessionId || session.key,
      key: session.key,
      agent: session.agent,
      channel: session.channel || 'unknown',
      kind: session.chatType || 'unknown',
      model: session.model || 'unknown',
      active: session.active,
      updatedAt: session.updatedAt,
      totalTokens: session.totalTokens || 0,
    })),
  }
}

function collectDiscordActivity(sessions: GatewaySession[]): DiscordActivity[] {
  const stateDir = config.openclawStateDir
  if (!stateDir) return []

  const events: DiscordActivity[] = []
  for (const session of sessions.filter((entry) => entry.channel === 'discord').slice(0, 8)) {
    if (!session.sessionId) continue
    const raw = readSessionJsonl(stateDir, session.agent, session.sessionId)
    if (!raw) continue

    const messages = parseJsonlTranscript(raw, 20)
    let partIndex = 0
    for (const message of messages) {
      const ts = message.timestamp ? new Date(message.timestamp).getTime() : session.updatedAt
      for (const part of message.parts) {
        if (part.type !== 'text') {
          partIndex += 1
          continue
        }
        const excerpt = part.text.replace(/\s+/g, ' ').trim()
        if (!excerpt) {
          partIndex += 1
          continue
        }
        events.push({
          id: `${session.sessionId}:${partIndex}`,
          ts,
          agent: session.agent,
          sessionKey: session.key,
          role: message.role,
          excerpt: excerpt.slice(0, 160),
        })
        partIndex += 1
      }
    }
  }

  return events.sort((a, b) => b.ts - a.ts).slice(0, 12)
}

async function listOmxTeams(projectPath: string): Promise<string[]> {
  const teamDirs = [
    path.join(projectPath, '.omx', 'state', 'team'),
    path.join(projectPath, '.omx', 'team'),
  ]
  const names = new Set<string>()

  for (const teamDir of teamDirs) {
    try {
      const entries = await fs.readdir(teamDir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) names.add(entry.name)
      }
    } catch {
      // Team state is optional until the first OMX team has been launched.
    }
  }

  return [...names].sort()
}

async function loadOmxSummaries(projectPath: string): Promise<OmxTeamSummary[]> {
  const teams = await listOmxTeams(projectPath)
  const summaries = await Promise.all(teams.slice(0, 5).map(async (teamName) => {
    try {
      const { stdout } = await runCommand(
        'omx',
        ['team', 'api', 'get-summary', '--input', JSON.stringify({ team_name: teamName }), '--json'],
        { cwd: projectPath, timeoutMs: 10000 },
      )
      const parsed = JSON.parse(stdout) as { data?: { summary?: Omit<OmxTeamSummary, 'projectPath'> } }
      const summary = parsed.data?.summary
      return summary ? { projectPath, ...summary } : null
    } catch (error) {
      logger.warn({ err: error, teamName }, 'Failed to load OMX team summary')
      return null
    }
  }))

  return summaries.filter((summary): summary is OmxTeamSummary => Boolean(summary))
}

function readPositiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return fallback
  return Math.min(Math.floor(parsed), max)
}

function splitPathList(value: string | undefined): string[] {
  return (value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath)
    return stat.isDirectory()
  } catch {
    return false
  }
}

async function hasOmxTeamState(projectPath: string): Promise<boolean> {
  return (
    await directoryExists(path.join(projectPath, '.omx', 'state', 'team')) ||
    await directoryExists(path.join(projectPath, '.omx', 'team'))
  )
}

function getDefaultOmxDiscoveryRoots(homeDir: string): string[] {
  return [
    process.cwd(),
    path.join(homeDir, 'workspace'),
    path.join(homeDir, 'projects'),
    path.join(homeDir, 'clawd-agents'),
    path.join(homeDir, '.openclaw', 'workspace'),
  ]
}

const IGNORED_DISCOVERY_DIRS = new Set([
  '.git',
  '.next',
  '.omx',
  '.turbo',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
])

async function discoverOmxProjectsUnder(rootPath: string, maxDepth: number, results: Set<string>) {
  const resolvedRoot = path.resolve(rootPath)
  if (!(await directoryExists(resolvedRoot))) return

  if (await hasOmxTeamState(resolvedRoot)) {
    results.add(resolvedRoot)
  }

  if (maxDepth <= 0) return

  let entries: Array<{ name: string; isDirectory(): boolean }>
  try {
    entries = await fs.readdir(resolvedRoot, { withFileTypes: true })
  } catch {
    return
  }

  const childDirs = entries
    .filter((entry) => entry.isDirectory())
    .filter((entry) => !IGNORED_DISCOVERY_DIRS.has(entry.name))
    .filter((entry) => !entry.name.startsWith('.') || entry.name === '.openclaw')
    .map((entry) => path.join(resolvedRoot, entry.name))
    .sort()
    .slice(0, 200)

  await Promise.all(childDirs.map((childPath) => discoverOmxProjectsUnder(childPath, maxDepth - 1, results)))
}

async function discoverOmxProjectPaths(): Promise<string[]> {
  const homeDir = os.homedir()
  const explicitPaths = [
    ...splitPathList(process.env.MISSION_CONTROL_OMX_PROJECT_PATHS),
    ...splitPathList(process.env.MISSION_CONTROL_OMX_PROJECT_PATH),
  ]
  const discoveryRoots = splitPathList(process.env.MISSION_CONTROL_OMX_DISCOVERY_ROOTS)
  const roots = discoveryRoots.length > 0 ? discoveryRoots : getDefaultOmxDiscoveryRoots(homeDir)
  const discoveryDepth = readPositiveInt(process.env.MISSION_CONTROL_OMX_DISCOVERY_DEPTH, 3, 6)
  const results = new Set<string>()

  for (const projectPath of explicitPaths) {
    const resolved = path.resolve(projectPath)
    if (await directoryExists(resolved)) results.add(resolved)
  }

  for (const root of roots) {
    await discoverOmxProjectsUnder(root, discoveryDepth, results)
  }

  if (results.size === 0) {
    const cwd = path.resolve(process.cwd())
    if (await directoryExists(cwd)) results.add(cwd)
  }

  return [...results].sort()
}

async function loadOmxProjectSummaries(): Promise<OmxProjectSummary[]> {
  const projectPaths = await discoverOmxProjectPaths()
  const projects = await Promise.all(projectPaths.slice(0, 12).map(async (projectPath) => ({
    projectPath,
    teams: await loadOmxSummaries(projectPath),
  })))

  return projects
}

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const workspaceId = auth.user.workspace_id ?? 1
  try {
    const gatewaySessions = getAllGatewaySessions(60 * 60 * 1000, true)
    const [gateway, omxProjects] = await Promise.all([
      loadGatewayHealth(),
      loadOmxProjectSummaries(),
    ])
    const omxTeams = omxProjects.flatMap((project) => project.teams)

    return NextResponse.json({
      generatedAt: Date.now(),
      gateway,
      sessions: summarizeSessions(gatewaySessions),
      tasks: loadTaskSummary(workspaceId),
      discordActivity: collectDiscordActivity(gatewaySessions),
      omx: {
        projectPath: omxProjects[0]?.projectPath ?? process.cwd(),
        projectPaths: omxProjects.map((project) => project.projectPath),
        projects: omxProjects,
        teams: omxTeams,
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/openclaw/mission-control error')
    return NextResponse.json({ error: 'Failed to build Mission Control overview' }, { status: 500 })
  }
}

export const dynamic = 'force-dynamic'
