# 🔧 OpenClaw Setup Guide

## Quick Start with CLI

OpenClaw now includes a command-line setup tool for easy configuration of your OpenAI authentication.

### Installation

```bash
# Install dependencies
npm install

# Optional: Install globally for openclaw command
npm link
```

## Setup Commands

### Interactive Setup

```bash
# Using npm script
npm run setup-token

# Or using the openclaw command (if linked)
openclaw setup-token

# Or directly
node cli-setup.js
```

### Quick API Key Setup

```bash
# Set API key directly
openclaw setup-token --api-key sk-proj-...

# Or via npm
npm run setup -- --api-key sk-proj-...
```

### OAuth Setup

```bash
# Configure OAuth credentials
openclaw setup-token --oauth
```

### Test Your Setup

```bash
# Test authentication and fetch usage
openclaw setup-token --test

# Or run full integration test
openclaw test
```

### Clear Credentials

```bash
# Remove all saved authentication
openclaw setup-token --clear
```

## Authentication Methods

### Method 1: API Key (Quick Setup)

1. Get your API key from [OpenAI API Keys](https://platform.openai.com/api-keys)
2. Run setup:
   ```bash
   openclaw setup-token
   ```
3. Choose option 1 and enter your API key
4. Start the app:
   ```bash
   openclaw start
   ```

**Note:** Most API keys don't have billing access, so usage will be simulated.

### Method 2: OAuth (Full Features)

1. Register an OAuth app at [OpenAI OAuth Settings](https://platform.openai.com/settings/oauth)
   - Set redirect URI to: `http://localhost:8765/callback`
   - Copy your Client ID and Secret

2. Run OAuth setup:
   ```bash
   openclaw setup-token --oauth
   ```

3. Enter your Client ID and Secret

4. Start the app and complete login:
   ```bash
   openclaw start
   ```

## CLI Commands Reference

```bash
openclaw <command> [options]

Commands:
  setup-token        Configure OpenAI authentication
  setup              Alias for setup-token
  test               Test OpenAI integration
  start              Start the desktop pet app
  run                Alias for start
  help               Show help message

Setup Options:
  --api-key <key>    Set API key directly
  --oauth            Configure OAuth
  --test             Test authentication
  --clear            Clear saved credentials
  --help             Show help
```

## Environment Variables

You can also set authentication via environment variables:

```bash
# API Key method
export OPENAI_API_KEY="sk-..."

# OAuth method (for development)
export OPENAI_CLIENT_ID="your-client-id"
export OPENAI_CLIENT_SECRET="your-client-secret"

# Then start the app
npm start
```

## Configuration Files

Authentication is stored in:
- Config: `~/.openclaw-pet/config.json`
- Token: `~/.openclaw-pet/openai-token.json`
- Usage cache: `~/.openclaw-pet/real-usage.json`

## Troubleshooting

### "Invalid API key format"
- Ensure your key starts with `sk-`
- Check for extra spaces or quotes

### "Cannot fetch usage with API key"
- This is normal - most API keys lack billing access
- The app will use simulated usage tracking
- For real usage, use OAuth authentication

### "OAuth app not registered"
1. Go to https://platform.openai.com/settings/oauth
2. Create a new OAuth application
3. Set redirect URI to `http://localhost:8765/callback`
4. Run `openclaw setup-token --oauth` with your credentials

### Test Authentication

```bash
# Quick test
openclaw setup-token --test

# Full integration test
openclaw test
```

## Examples

```bash
# First time setup (interactive)
$ openclaw setup-token
🔍 Checking existing configuration...
❌ No existing authentication found

🔧 Choose authentication method:
1. API Key (Quick setup, limited features)
2. OAuth (Full features, requires app registration)
3. Cancel

Enter your choice (1-3): 1

📝 API Key Setup
─────────────────
Get your API key from:
https://platform.openai.com/api-keys

Enter your OpenAI API key: ********
🔍 Testing API key...
✅ API key is valid!
✅ API key saved successfully!

# Quick API key setup
$ openclaw setup-token --api-key sk-proj-abc123...
✅ API key saved!
✅ Successfully fetched usage data!
   Current usage: 15%
   Subscription: OpenAI Plus
   Reset date: 12/31/2024

# Start the app
$ openclaw start
Starting OpenClaw Pet...
```

## Security Notes

- Credentials are stored locally in your home directory
- API keys are never sent to third parties
- OAuth tokens are automatically refreshed when needed
- Use `openclaw setup-token --clear` to remove all credentials

## Support

For issues or questions:
1. Run `openclaw setup-token --test` to diagnose problems
2. Check the configuration files in `~/.openclaw-pet/`
3. Open an issue on GitHub with the test output