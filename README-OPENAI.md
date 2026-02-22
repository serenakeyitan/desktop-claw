# ChatGPT Plus Usage Tracker - OpenClaw Pet

This desktop pet tracks your ChatGPT Plus subscription usage, specifically GPT-4 message limits.

## Features

- 🤖 Animated desktop pet that shows your GPT-4 usage
- 📊 Real-time tracking of GPT-4 message limits (80 messages per 3 hours)
- 🔐 Secure session-based authentication with ChatGPT
- 🔄 3-hour rolling window tracking
- ⏱️ Live countdown timer to next reset

## Installation

1. Clone the repository
2. Install dependencies:
```bash
npm install
```

## Setup

### Quick Start

1. Run the setup command:
```bash
openclaw setup-token
```

2. Start the application:
```bash
npm start
```

3. Click "Login to ChatGPT" in the setup window

4. Sign in with your OpenAI account (ChatGPT Plus required)

5. The pet will appear and track your GPT-4 usage!

## How It Works

The app tracks your ChatGPT Plus subscription's GPT-4 message limits:

### GPT-4 Limits
- **80 messages** every 3 hours
- Automatic reset after 3-hour window
- Local tracking of messages sent
- Visual indicators for usage levels

### Usage Display
- **Green (0-50%)**: Safe zone - plenty of messages left
- **Yellow (50-80%)**: Moderate usage - approaching limit
- **Red (80-100%)**: Near limit - consider waiting for reset

### Features
- Live countdown timer to next reset
- Animated pet reactions based on usage
- Right-click menu for quick actions
- Draggable window (can be locked in place)

## Manual Usage Update

If the automatic tracking is off, you can manually update:

1. Right-click the pet
2. Select "📊 Update Usage"
3. Enter the number of messages you've used
4. The pet will update the display

## CLI Commands

```bash
# Setup ChatGPT Plus tracking
openclaw setup-token

# Test your session
openclaw setup-token --test

# Clear saved session
openclaw setup-token --clear

# Start the app
openclaw start
```

## Troubleshooting

### "No ChatGPT session found"
1. Run `npm start`
2. Click "Login to ChatGPT"
3. Sign in with your OpenAI account
4. Make sure you have ChatGPT Plus

### Usage not updating
- The app tracks usage locally
- Manual updates may be needed
- Check ChatGPT directly for exact count

### Pet not appearing
- Check if the app is running
- Look in the bottom-right corner of your screen
- Try restarting the app

## Privacy

- All authentication tokens are stored locally in `~/.openclaw-pet/`
- No data is sent to external servers except OpenAI's API
- OAuth tokens are refreshed automatically when needed

## License

MIT

## Support

For issues or questions, please open an issue on GitHub.