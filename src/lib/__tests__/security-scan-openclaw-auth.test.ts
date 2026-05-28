import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Regression coverage for the production OpenClaw config shape used by this
// deployment. The scanner previously called `.trim()` on gateway.auth.token,
// which crashed when token was an env-reference object instead of a string and
// made /api/security-scan return 500 during onboarding/hardening checks.
describe('OpenClaw security scan auth config', () => {
  const originalEnv = { ...process.env }
  let tempDir = ''
  let configPath = ''

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'mc-security-scan-'))
    configPath = path.join(tempDir, 'openclaw.json')
    process.env = {
      ...originalEnv,
      AUTH_PASS: 'correct-horse-battery-staple',
      API_KEY: 'test-api-key',
    }
  })

  afterEach(() => {
    vi.resetModules()
    vi.unmock('@/lib/config')
    vi.unmock('@/lib/db')
    process.env = { ...originalEnv }
    rmSync(tempDir, { recursive: true, force: true })
  })

  async function runScanWithOpenClawConfig(openclawConfig: unknown) {
    // Mock only the scanner's environment dependencies so the test stays focused
    // on OpenClaw auth parsing rather than local DB or machine hardening state.
    writeFileSync(configPath, JSON.stringify(openclawConfig), 'utf-8')
    vi.resetModules()
    vi.doMock('@/lib/config', () => ({
      config: {
        openclawConfigPath: configPath,
        gatewayHost: '127.0.0.1',
        dbPath: path.join(tempDir, 'mission-control.db'),
      },
    }))
    vi.doMock('@/lib/db', () => ({
      getDatabase: vi.fn(() => {
        throw new Error('db unavailable in unit test')
      }),
    }))

    const { runSecurityScan } = await import('@/lib/security-scan')
    return runSecurityScan()
  }

  it('accepts object-backed gateway token references without throwing', async () => {
    const result = await runScanWithOpenClawConfig({
      gateway: {
        auth: {
          mode: 'token',
          token: {
            source: 'env',
            provider: 'env',
            id: 'OPENCLAW_GATEWAY_TOKEN',
          },
        },
        bind: 'loopback',
      },
    })

    const gatewayAuthCheck = result.categories.openclaw.checks.find((check) => check.id === 'gateway_auth')

    expect(gatewayAuthCheck?.status).toBe('pass')
    expect(gatewayAuthCheck?.detail).toContain('OPENCLAW_GATEWAY_TOKEN')
  })
})
