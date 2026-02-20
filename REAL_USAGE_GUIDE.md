# OpenClaw Pet - Real Usage Data Guide

## How to Display Your Real Claude Usage in OpenClaw Pet

Since Claude Code requires authentication, OpenClaw Pet provides multiple ways to display your real usage data:

### Method 1: Manual Usage Update (Easiest)

1. **Check your usage in Claude Code:**
   ```bash
   claude /usage
   ```
   This will show something like:
   ```
   5-hour: 45% (resets in 3.2 hours)
   7-day: 23% (resets in 4.5 days)
   ```

2. **Update OpenClaw Pet with your usage percentage:**
   ```bash
   node manual-usage-update.js 45
   ```
   Replace `45` with your actual 5-hour usage percentage.

3. **The pet will immediately show your real usage!**
   - The data is saved in `~/.openclaw-pet/real-usage.json`
   - The app checks for updates every 30 seconds
   - Data stays valid for 6 hours

### Method 2: Claude Code Integration (Advanced)

If you want automatic usage tracking:

1. **Make sure Claude Code is installed and authenticated:**
   ```bash
   claude --version
   ```

2. **The app will try to spawn Claude Code and run /usage automatically**
   - This requires you to be logged into Claude Code
   - The ClaudeUsageFetcher module handles this

### Method 3: OAuth Login (When Available)

The app supports OAuth login through the setup wizard:
- Click "Login with Claude Account" in the setup
- This will open your browser for authentication
- Currently limited by API availability

## Troubleshooting

### Pet shows demo/estimated data instead of real usage?
- Run `node manual-usage-update.js <percentage>` with your current usage
- Make sure the file `~/.openclaw-pet/real-usage.json` exists
- Restart the app: `npm start`

### How to check if real data is being used?
Look for these indicators in the pet display:
- "realData: true" in the usage data
- "source: manual update" or "source: Claude Code /usage command"
- The exact percentage you set with manual update

### Updating usage regularly
You can create a simple script or alias:
```bash
# Add to your ~/.bashrc or ~/.zshrc
alias update-openclaw='claude /usage && echo "Enter percentage:" && read pct && node ~/desktop_bot/manual-usage-update.js $pct'
```

Then just run `update-openclaw` anytime to update your usage.

## Architecture

The app checks for real usage data in this priority order:
1. Manual usage file (`~/.openclaw-pet/real-usage.json`)
2. Claude Code session (ClaudeUsageFetcher)
3. OAuth API (when available)
4. Local tracking (fallback)

## Files

- `manual-usage-update.js` - Script to manually set usage percentage
- `claude-usage-fetcher.js` - Module that spawns Claude Code and runs /usage
- `~/.openclaw-pet/real-usage.json` - Stored real usage data
- `~/.openclaw-pet/config.json` - App configuration including auth settings