# OpenClaw Dev Lifecycle

This contract keeps a Discord or Telegram project channel tied to one repeatable development loop:

1. route the channel to the OpenClaw dev project manager agent
2. have the dev PM create or use a repo under a monitored project root
3. launch an OMX team from that repo for implementation, verification, or review
4. monitor OpenClaw sessions, Discord transcript activity, task state, and OMX team state in Mission Control
5. deploy the app and record the health check evidence before calling the work done

## Channel Contract

Use one channel per project or major workstream. The channel prompt should name the repo path, branch policy, deployment target, and stop conditions.

```text
OpenClawV2 dev PM: start project <project-slug>.

Repo: /home/amish/workspace/<project-slug>
Channel: this Discord channel
Goal: <user-visible outcome>

Use built-in OpenClaw features first. When code work is needed, launch a tmux-backed OMX team from the repo. Post the OMX team name, task split, monitoring commands, and deployment/check URLs back to this channel. Do not expose secrets.

Stop only after:
- code is committed or an explicit blocker is documented
- typecheck, tests, build, and any project-specific e2e checks are reported
- Mission Control can see the active/recent OpenClaw session and OMX team state
- deployment health checks pass or the exact remaining deployment blocker is documented
```

The dev PM should prefer `/home/amish/workspace/<project-slug>` or `/home/amish/projects/<project-slug>` for new repos. Mission Control scans those roots by default for `.omx/state/team/*` runtimes. Add important one-off repos to `MISSION_CONTROL_OMX_PROJECT_PATHS`.

## LOBSTER Workflow

LOBSTER is the repeatable handoff shape for channel-driven development:

- **Launch**: verify OpenClaw gateway/channel health and ask the dev PM to create or select the repo.
- **Observe**: confirm the OpenClaw session appears in Mission Control and the Discord transcript records the plan.
- **Build**: start `omx team ...` from the repo for implementation and verification lanes.
- **Stabilize**: run the repo's quality gates and fix failures before deployment.
- **Tunnel**: expose the running app through Tailscale Serve, Funnel, or an approved reverse tunnel.
- **Evaluate**: run health checks against the exposed URL and capture screenshots/e2e evidence when relevant.
- **Record**: commit code, update docs, and post the final team/session/deploy evidence to the project channel.

## Monitoring Commands

OpenClaw channel and session health:

```bash
openclaw channels status --probe --timeout 45000
openclaw sessions --all-agents --active 240 --limit 20
openclaw message read --channel discord --target channel:<discord-channel-id> --limit 20 --json
```

OMX team state from the project repo:

```bash
omx team status <team-name> --json --tail-lines 500
omx team api get-summary --input '{"team_name":"<team-name>"}' --json
tmux capture-pane -pt <tmux-session>:0.<worker-pane-index> -S -260
```

Mission Control deployment health:

```bash
curl -fsS http://127.0.0.1:${PORT:-3000}/login >/dev/null
curl -fsS http://127.0.0.1:${PORT:-3000}/api/status?action=health
systemctl --user status mission-control.service --no-pager
```

## Dashboard Coverage

The Mission Control overview widget tracks:

- OpenClaw gateway reachability and configured/connected channels
- recent OpenClaw sessions across agents and channels
- recent Discord transcript activity
- Mission Control task status counts
- OMX teams discovered under configured project roots

For future projects, keep team work inside one of these roots or update env:

```env
MISSION_CONTROL_OMX_PROJECT_PATHS=/home/amish/mission-control,/home/amish/workspace/important-app
MISSION_CONTROL_OMX_DISCOVERY_ROOTS=/home/amish/workspace,/home/amish/projects,/home/amish/clawd-agents
MISSION_CONTROL_OMX_DISCOVERY_DEPTH=3
```

Restart `mission-control.service` after changing runtime env.
