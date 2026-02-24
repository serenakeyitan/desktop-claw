# All Day Poke - Usage Update Guide

## The Challenge

Claude Code's `/usage` command displays your token usage in a modern interactive terminal interface that uses complex escape sequences. This makes it impossible to automatically capture the usage data through scripts. However, I've created multiple ways for you to manually update the usage so your pet shows accurate data.

## How to Update Your Usage

### Method 1: Right-Click Menu (Easiest)

1. **Right-click** on the All Day Poke pet robot
2. Select **📊 Update Usage** from the menu
3. A small window will appear
4. Run `/usage` in Claude Code to see your current usage percentage
5. Enter the percentage number (e.g., if it shows "5-hour: 42%", enter 42)
6. Click **Save**
7. The pet will automatically reload with your updated usage

### Method 2: Command Line Tool

Run the interactive updater:
```bash
node update-usage.js
```

Or update directly with a percentage:
```bash
node update-usage.js 42
```

This will save your usage as 42%.

### Method 3: Manual File Edit

Edit the file directly at `~/.alldaypoke/real-usage.json`:

```json
{
  "percentage": 42,
  "used": 42,
  "limit": 100,
  "resetAt": "2026-02-19T03:51:03.995Z",
  "subscription": "Claude Pro",
  "type": "5-hour",
  "realData": true,
  "timestamp": "2026-02-18T22:51:03.995Z",
  "source": "manual-update"
}
```

Just change the `percentage` and `used` values to match your current usage.

## Understanding the Display

- **Green (0-50%)**: Low usage, robot is happy and active
- **Yellow (50-75%)**: Medium usage, robot is working steadily
- **Orange (75-90%)**: High usage, robot is working hard
- **Red (90-100%)**: Very high usage, robot is exhausted

## Why Manual Updates?

Claude Code uses a sophisticated terminal UI that prevents automated capture of the `/usage` output. The terminal renders the interface using:
- ANSI escape sequences for colors and cursor positioning
- Interactive UI elements that don't produce plain text output
- Terminal emulation that requires a real TTY

I tried multiple approaches including:
- Expect scripts
- Python pexpect automation
- Direct subprocess piping
- Terminal emulation with `script` command

All failed because Claude Code detects it's not running in an interactive terminal and outputs escape codes instead of readable text.

## Files Created for Usage Management

- `update-usage.js` - Interactive command-line updater
- `manual-usage-update.js` - Direct percentage updater
- `~/.alldaypoke/real-usage.json` - Storage for your usage data
- Right-click menu option in the pet for easy updates

## Troubleshooting

**Pet not showing updated usage?**
- Right-click the pet and select "Reload"
- Or restart the app: `pkill -f electron && npm start`

**Can't see the pet?**
- Check if it's running: `ps aux | grep electron`
- Start it: `npm start`

**Want to reset to automatic (demo) mode?**
- Delete the usage file: `rm ~/.alldaypoke/real-usage.json`
- Restart the app

## Current Status

Your usage is currently set to **25%** (last updated at 22:51:03 UTC).

The pet reads from `~/.alldaypoke/real-usage.json` every 30 seconds, so any updates you make will be reflected automatically within half a minute.