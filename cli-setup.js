#!/usr/bin/env node

const readline = require('readline');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const crypto = require('crypto');

// Configuration paths
const CONFIG_DIR = path.join(os.homedir(), '.alldaypoke');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const TOKEN_FILE = path.join(CONFIG_DIR, 'openai-token.json');

// Colors for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m'
};

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function print(message, color = '') {
  console.log(color + message + colors.reset);
}

function printHeader() {
  console.clear();
  print('╔════════════════════════════════════════╗', colors.cyan);
  print('║                                        ║', colors.cyan);
  print('║       All Day Poke - Setup Token       ║', colors.cyan);
  print('║         OpenAI Usage Tracker           ║', colors.cyan);
  print('║                                        ║', colors.cyan);
  print('╚════════════════════════════════════════╝', colors.cyan);
  console.log();
}

function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer);
    });
  });
}

function hiddenQuestion(prompt) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;

    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let password = '';
    stdin.on('data', (char) => {
      char = char.toString();

      if (char === '\n' || char === '\r' || char === '\u0004') {
        stdin.setRawMode(false);
        stdin.pause();
        stdout.write('\n');
        resolve(password);
      } else if (char === '\u0003') {
        // Ctrl+C
        process.exit();
      } else if (char.charCodeAt(0) === 127 || char.charCodeAt(0) === 8) {
        // Backspace
        if (password.length > 0) {
          password = password.slice(0, -1);
          stdout.clearLine();
          stdout.cursorTo(0);
          stdout.write(prompt + '*'.repeat(password.length));
        }
      } else {
        password += char;
        stdout.write('*');
      }
    });
  });
}

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (error) {
    // Ignore errors
  }
  return {};
}

function saveConfig(config) {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function saveToken(tokenData) {
  ensureConfigDir();
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2));
}

async function setupSubscription() {
  print('\n🔐 ChatGPT Plus Subscription Setup', colors.bright);
  print('────────────────────────────────────', colors.cyan);
  console.log();

  print('This will set up tracking for your ChatGPT Plus subscription.', colors.yellow);
  print('You\'ll track GPT-4 message limits (80 messages per 3 hours).\n', colors.cyan);

  const confirm = await question(colors.yellow + 'Ready to login to ChatGPT? (y/n): ' + colors.reset);

  if (confirm.toLowerCase() !== 'y') {
    print('\n❌ Setup cancelled', colors.red);
    return false;
  }

  // Save configuration for subscription auth
  const config = loadConfig();
  config.authType = 'openai-subscription';
  saveConfig(config);

  print('\n✅ Configuration saved!', colors.green);
  print('\n📝 Next steps:', colors.yellow);
  print('1. Run the app with: npm start', colors.cyan);
  print('2. Click "Login to ChatGPT" in the setup window', colors.cyan);
  print('3. Sign in with your OpenAI account', colors.cyan);
  print('4. The pet will track your GPT-4 usage', colors.cyan);

  print('\n💡 Features:', colors.yellow);
  print('• Tracks GPT-4 message limits (80/3hr)', colors.green);
  print('• Shows usage percentage and reset timer', colors.green);
  print('• Updates automatically as you use ChatGPT', colors.green);

  return true;
}

async function setupOAuth() {
  print('\n🔐 OAuth Setup', colors.bright);
  print('──────────────', colors.cyan);
  console.log();

  print('OAuth provides the most accurate usage tracking.', colors.yellow);
  print('You\'ll need to register your app at:', colors.yellow);
  print('https://platform.openai.com/settings/oauth\n', colors.blue);

  const hasApp = await question(colors.yellow + 'Have you registered an OAuth app? (y/n): ' + colors.reset);

  if (hasApp.toLowerCase() !== 'y') {
    print('\nPlease register an OAuth app first:', colors.yellow);
    print('1. Go to https://platform.openai.com/settings/oauth', colors.cyan);
    print('2. Create a new OAuth app', colors.cyan);
    print('3. Set redirect URI to: http://localhost:8765/callback', colors.cyan);
    print('4. Copy your Client ID and Client Secret', colors.cyan);
    print('\nThen run this setup again.', colors.yellow);
    return false;
  }

  const clientId = await question(colors.yellow + 'Enter your Client ID: ' + colors.reset);
  const clientSecret = await hiddenQuestion(colors.yellow + 'Enter your Client Secret: ' + colors.reset);

  if (!clientId || !clientSecret) {
    print('\n❌ Client ID and Secret are required', colors.red);
    return false;
  }

  // Save OAuth credentials
  const config = loadConfig();
  config.authType = 'openai-oauth-ready';
  config.oauthClientId = clientId;
  config.oauthClientSecret = clientSecret;
  saveConfig(config);

  // Set environment variables
  process.env.OPENAI_CLIENT_ID = clientId;
  process.env.OPENAI_CLIENT_SECRET = clientSecret;

  print('\n✅ OAuth credentials saved!', colors.green);
  print('\n📝 To complete OAuth setup:', colors.yellow);
  print('   Run the app with: npm start', colors.cyan);
  print('   Click "Login with OpenAI Account" in the setup window', colors.cyan);

  return true;
}

async function checkExistingSetup() {
  print('\n🔍 Checking existing configuration...', colors.yellow);

  const config = loadConfig();
  let hasAuth = false;

  if (config.authType === 'openai-subscription') {
    const sessionFile = path.join(os.homedir(), '.alldaypoke', 'openai-session.json');
    if (fs.existsSync(sessionFile)) {
      print('✅ Found ChatGPT Plus session', colors.green);
      hasAuth = true;
    } else {
      print('⚠️  Subscription configured but no session found', colors.yellow);
    }
  }

  if (hasAuth) {
    const replace = await question(colors.yellow + '\nReplace existing authentication? (y/n): ' + colors.reset);
    return replace.toLowerCase() === 'y';
  }

  print('❌ No existing authentication found', colors.yellow);
  return true;
}

async function testAuthentication() {
  print('\n🧪 Testing authentication...', colors.yellow);

  try {
    const OpenAISubscriptionAuth = require('./openai-subscription-auth');
    const auth = new OpenAISubscriptionAuth();

    if (auth.loadSavedSession()) {
      const usage = auth.getUsageData();
      print('✅ ChatGPT Plus session found!', colors.green);
      print(`   Current usage: ${usage.used}/${usage.limit} messages (${usage.percentage}%)`, colors.cyan);
      print(`   Model: ${usage.model}`, colors.cyan);
      print(`   Reset: ${new Date(usage.resetAt).toLocaleTimeString()}`, colors.cyan);
      return true;
    } else {
      print('❌ No ChatGPT session found', colors.red);
      print('   Please run the app and login to ChatGPT', colors.yellow);
      return false;
    }
  } catch (error) {
    print(`❌ Error: ${error.message}`, colors.red);
    return false;
  }
}

async function main() {
  printHeader();

  // Check for command line arguments
  const args = process.argv.slice(2);

  if (args.length > 0) {
    if (args[0] === '--help' || args[0] === '-h') {
      print('Usage: alldaypoke setup-token [options]\n', colors.bright);
      print('Options:', colors.yellow);
      print('  --test             Test current ChatGPT session', colors.cyan);
      print('  --clear            Clear saved ChatGPT session', colors.cyan);
      print('  --help             Show this help message', colors.cyan);
      print('\nThis tool sets up tracking for ChatGPT Plus subscriptions.', colors.yellow);
      print('It tracks GPT-4 message limits (80 messages per 3 hours).', colors.cyan);
      process.exit(0);
    }

    if (args[0] === '--clear') {
      ensureConfigDir();
      const config = loadConfig();
      delete config.authType;
      saveConfig(config);

      // Clear session file
      const sessionFile = path.join(os.homedir(), '.alldaypoke', 'openai-session.json');
      if (fs.existsSync(sessionFile)) {
        fs.unlinkSync(sessionFile);
      }

      print('✅ ChatGPT session cleared!', colors.green);
      print('Run the app to login again.', colors.yellow);
      process.exit(0);
    }

    if (args[0] === '--test') {
      const success = await testAuthentication();
      process.exit(success ? 0 : 1);
    }
  }

  // Interactive setup
  const shouldSetup = await checkExistingSetup();

  if (!shouldSetup) {
    print('\n✅ Keeping existing authentication', colors.green);
    await testAuthentication();
    rl.close();
    return;
  }

  print('\n🎯 All Day Poke tracks ChatGPT Plus usage (GPT-4 limits)', colors.bright);
  print('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', colors.cyan);
  print('\nChatGPT Plus includes:', colors.yellow);
  print('• 80 messages every 3 hours with GPT-4', colors.green);
  print('• Unlimited GPT-3.5 messages', colors.green);
  print('• Priority access during peak times\n', colors.green);

  const ready = await question(colors.yellow + 'Ready to set up ChatGPT Plus tracking? (y/n): ' + colors.reset);

  let success = false;

  if (ready.toLowerCase() === 'y') {
    success = await setupSubscription();
  } else {
    print('\n👋 Setup cancelled', colors.yellow);
    print('You can run setup again anytime with:', colors.cyan);
    print('  alldaypoke setup-token', colors.bright + colors.cyan);
  }

  if (success) {
    print('\n🎉 Setup complete!', colors.green);
    print('\nYou can now run the app with:', colors.yellow);
    print('  npm start', colors.bright + colors.cyan);
    print('\nOr test your setup with:', colors.yellow);
    print('  node cli-setup.js --test', colors.bright + colors.cyan);
  }

  rl.close();
}

// Handle cleanup
rl.on('close', () => {
  console.log();
  process.exit(0);
});

// Run main function
main().catch(error => {
  print(`\n❌ Setup failed: ${error.message}`, colors.red);
  rl.close();
  process.exit(1);
});