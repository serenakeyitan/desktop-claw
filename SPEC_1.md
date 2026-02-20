# OpenClaw Desktop Pet — Project Spec
> For Claude Code. Build this as a complete, runnable Electron app.

---

## Overview

A minimalist desktop widget that floats over all windows (bottom-right corner), shows real Claude API token usage, and animates a pixel-art Claude Code robot that reacts to whether the API is actively being called or idle.

No status buttons. No labels. Just the robot + one clean data strip.

---

## Visual Design

### Layout (200 × 220px transparent window)

```
┌─────────────────────┐
│                     │
│    [pixel robot]    │  ← 120×140px, centered
│                     │
│  ████░░░░░░░░  67%  │  ← token bar + percentage
│  resets in 4h 12m   │  ← next refresh countdown
│                     │
└─────────────────────┘
```

### Style rules
- Background: fully transparent (no panel, no card, no border)
- Font: `monospace`, 9–10px, color `#888` default / `#fff` active
- Token bar: 2px tall, no border, segmented pixel style
  - Green `#39ff14` > 60%
  - Yellow `#ffcc00` 30–60%  
  - Red `#ff3333` < 30%
- All elements have no drop shadow, no blur, no rounded corners
- CRT scanline overlay (5% opacity) over entire widget

### Robot — Claude Code Pixel Bot

Pixel art (16×20 grid, rendered at 100px wide via SVG).

Reference: Claude Code's mascot — boxy head, visor-style eyes, antenna, compact body.

```
Design language:
- Head: square, slightly wider than body
- Eyes: horizontal visor bar (single rect), not two dots
- Antenna: single pixel dot on top
- Body: rectangular, chest has a single indicator pixel
- Arms: stubby, angled slightly outward  
- Colors: #1a1a1a body, #39ff14 accent (eyes, hands, feet, indicator)
```

**States (2 only — auto-detected, no manual toggle):**

| State | Trigger | Animation |
|-------|---------|-----------|
| `IDLE` | No API calls in last 10s | Slow float up/down (3s cycle), blink every 4s |
| `ACTIVE` | API call detected in last 10s | Eyes pulse bright, body vibrates slightly (0.2s), antenna blinks |

State switches automatically. No UI for it.

---

## Functionality

### 1. Token Usage — Real API Data

Poll Anthropic usage endpoint to get real stats.

**Endpoint:** `https://api.anthropic.com/v1/usage` (or user-configured)

**Config** (read from `~/.openclaw-pet/config.json`):
```json
{
  "anthropic_api_key": "sk-ant-...",
  "poll_interval_seconds": 30,
  "api_base_url": "https://api.anthropic.com"
}
```

**Display:**
- Token bar: `tokens_used / tokens_limit` as percentage fill
- Percentage text: e.g. `67%`
- Countdown: `resets in 4h 12m` — live countdown to `reset_at` timestamp from API response
  - Updates every second locally (no re-poll needed)
  - When < 1 hour: show `resets in 42m`
  - When < 5 min: color turns red, text pulses

**On API error / no key:** show `-- %` and `no api key` in dim gray. Robot stays idle, no crash.

### 2. Activity Detection — Is the API in use?

Monitor for active API calls via one of these methods (try in order):

**Method A — Proxy mode (preferred)**
Run a local HTTP proxy on `localhost:9999`. User points their OpenClaw/Claude Code client at this proxy. The proxy forwards to the real Anthropic API and intercepts traffic to detect active calls.

When a request is in-flight → set `ACTIVE` state for 10s.

**Method B — Log file watching**
Watch `~/.claude/logs/` (Claude Code log directory) for new write events using `fs.watch`. Any new log line within 10s → `ACTIVE`.

**Method C — Fallback**
If neither works, poll `/v1/usage` and check if `tokens_used` increased since last poll → briefly set `ACTIVE`.

State resets to `IDLE` automatically after 10s of no activity.

### 3. Window Behavior

- Transparent, frameless Electron window
- `alwaysOnTop: true`, level: `'screen-saver'` (above fullscreen apps)
- Default position: bottom-right, 20px from edges
- Draggable (mousedown on robot area)
- `skipTaskbar: true`
- Right-click → context menu with: `Reload`, `Open Config`, `Quit`

---

## File Structure

```
openclaw-pet/
├── package.json
├── main.js              # Electron main — window setup, tray, IPC
├── preload.js           # Context bridge
├── proxy.js             # Local HTTP proxy for activity detection (Method A)
├── watcher.js           # Log file watcher (Method B)
├── usage-poller.js      # Anthropic API polling for token stats
├── renderer/
│   ├── index.html       # Widget shell
│   ├── robot.js         # SVG robot + animation state machine
│   ├── stats.js         # Token bar + countdown rendering
│   └── style.css        # Minimal styles
└── config/
    └── defaults.json    # Default config values
```

---

## Tech Stack

- **Electron** v28+
- **Node.js** built-ins only (`http`, `fs`, `path`) — no extra npm deps for core
- **SVG** for robot (no canvas, no pixi)
- **CSS animations** for all movement (no JS animation loops)

---

## IPC Channels

```
main → renderer:
  'token-update'   { used, limit, pct, reset_at }
  'state-change'   { state: 'idle' | 'active' }
  'reset-tick'     { timeLeft: '4h 12m' }

renderer → main:
  'open-config'    open config file in default editor
  'drag-move'      { dx, dy }
```

---

## Config File

Location: `~/.openclaw-pet/config.json`

```json
{
  "anthropic_api_key": "",
  "poll_interval_seconds": 30,
  "activity_timeout_seconds": 10,
  "proxy_port": 9999,
  "detection_method": "auto",
  "position": { "x": null, "y": null }
}
```

If file doesn't exist, create it with defaults on first launch and open it in the user's editor.

---

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| No config file | Auto-create, open in editor, show `setup needed` |
| API key invalid | Show `auth error` in red, idle robot |
| Rate limit on usage endpoint | Back off 5min, show last known data with `(cached)` |
| Tokens at 0% | Robot enters slow pulse, countdown shows reset time |
| Network offline | Show last data + `(offline)` label |
| Window off-screen (multi-monitor removed) | Re-anchor to primary display bottom-right |

---

## What NOT to build

- No settings UI panel
- No state toggle buttons
- No notifications or sounds
- No history charts
- No tray icon (keep it invisible except the robot)
- No splash screen
- No auto-updater

---

## Success Criteria

1. Launch → robot appears bottom-right, transparent, above all windows
2. Real token % shows within 30s of launch
3. Countdown ticks live every second
4. Robot visibly changes when API is active vs idle (no user action needed)
5. Right-click → quit works
6. Dragging repositions the widget and persists position
