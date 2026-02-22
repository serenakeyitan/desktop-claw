# 🎯 ChatGPT Plus Usage Tracker - Complete Solution

## Overview

This is a desktop pet application that tracks your **ChatGPT Plus subscription usage**, specifically the GPT-4 message limits (80 messages per 3 hours). It works similarly to subscription tracking for other services, monitoring your actual ChatGPT activity rather than API usage.

## Key Features

### 🤖 What It Tracks
- **GPT-4 Message Limits**: 80 messages per 3-hour rolling window
- **Real-time Usage**: Shows current message count and percentage
- **Reset Timer**: Countdown to when your limit resets
- **Local Tracking**: Monitors usage based on detected ChatGPT activity

### 🎨 Visual Indicators
- **Green (0-50%)**: Safe zone - plenty of messages remaining
- **Yellow (50-80%)**: Moderate usage - approaching limit
- **Red (80-100%)**: Near limit - consider waiting for reset

## Setup Process

### 1. Initial Setup
```bash
# Install dependencies
npm install

# Run setup command
openclaw setup-token

# Or directly start the app
npm start
```

### 2. Login to ChatGPT
1. Click "Login to ChatGPT" in the setup window
2. Sign in with your OpenAI account
3. Must have ChatGPT Plus subscription
4. The app captures your session for tracking

### 3. Usage Tracking
The pet will appear on your desktop showing:
- Current message count (e.g., "32/80")
- Usage percentage with color coding
- Time until next reset
- Animated reactions based on usage level

## Architecture

### Authentication (`openai-subscription-auth.js`)
- Captures ChatGPT web session via Electron browser window
- Stores session cookies locally for persistence
- No API keys required - uses your actual ChatGPT login

### Usage Tracking
- **3-Hour Windows**: Tracks messages in rolling 3-hour periods
- **Local Storage**: Usage data saved in `~/.openclaw-pet/openai-session.json`
- **Automatic Reset**: Clears count after 3-hour window expires

### Message Detection
- Monitors for ChatGPT activity
- Can be triggered manually via right-click menu
- Tracks each GPT-4 message sent

## CLI Commands

```bash
# Interactive setup
openclaw setup-token

# Test current session
openclaw setup-token --test

# Clear saved session
openclaw setup-token --clear

# Start the application
openclaw start
```

## File Structure

### Core Files
- `openai-subscription-auth.js` - ChatGPT session management
- `cli-setup.js` - Command-line setup wizard
- `main.js` - Electron app main process
- `renderer/setup.html` - Setup UI for ChatGPT login

### Configuration
- Config: `~/.openclaw-pet/config.json`
- Session: `~/.openclaw-pet/openai-session.json`
- Usage tracking: Local, no external API calls

## How It's Different

### From API Tracking
- **No API Key Needed**: Uses your ChatGPT web session
- **Subscription-Based**: Tracks ChatGPT Plus limits, not API credits
- **3-Hour Windows**: Not monthly billing cycles
- **Message Count**: Not dollar amounts

### From the Original Claude Tracker
- **GPT-4 Limits**: 80 messages/3hr vs Claude's 5-hour windows
- **Session Auth**: ChatGPT login vs Claude tokens
- **Local Only**: No API endpoint for real usage data

## Testing

Run tests with:
```bash
# Test subscription tracking
node test-subscription.js

# Test with CLI
openclaw setup-token --test
```

## Manual Usage Updates

If automatic tracking is off:
1. Right-click the pet
2. Select "📊 Update Usage"
3. Enter number of messages used
4. Pet updates display

## Limitations

1. **Local Tracking Only**: Cannot fetch real usage from OpenAI servers
2. **Manual Updates**: May need to manually sync with actual usage
3. **Session-Based**: Requires re-login if session expires
4. **ChatGPT Plus Only**: Doesn't work with free ChatGPT accounts

## Privacy & Security

- ✅ All data stored locally
- ✅ No external servers involved
- ✅ Session cookies encrypted and local
- ✅ No usage data sent anywhere

## Troubleshooting

### "No ChatGPT session found"
- Run the app and login to ChatGPT
- Make sure you have ChatGPT Plus

### Usage not updating
- Tracking is local - may need manual updates
- Check ChatGPT directly for exact count

### Session expired
- Clear session: `openclaw setup-token --clear`
- Login again through the app

## Why Subscription Tracking?

Most users want to track their actual ChatGPT Plus usage, not API usage:
- ChatGPT Plus is what most people use daily
- GPT-4 message limits are the main constraint
- API keys are for developers, not general users
- Subscription tracking is more relevant for everyday use

## Summary

This solution provides a desktop widget that tracks your ChatGPT Plus GPT-4 message usage with:
- Simple setup via ChatGPT login
- Local tracking of message limits
- Visual feedback via animated pet
- 3-hour rolling window monitoring
- No API keys or complex configuration

Perfect for ChatGPT Plus users who want to monitor their GPT-4 usage and avoid hitting the message limit!