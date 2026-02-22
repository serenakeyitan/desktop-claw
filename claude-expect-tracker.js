#!/usr/bin/env node

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const EventEmitter = require('events');
const { getClaudeBinaryPath, checkClaudeAuth } = require('./claude-path');

class ClaudeExpectTracker extends EventEmitter {
  constructor() {
    super();
    this.usageFile = path.join(os.homedir(), '.openclaw-pet', 'real-usage.json');
    this.expectScript = path.join(__dirname, 'get-claude-usage.exp');
    this.checkInterval = null;
    this.claudeBinary = null;
    this.lastUsage = null;
    this.isChecking = false;
  }

  // Start tracking
  async start() {
    console.log('Starting Claude Code expect-based usage tracking...');

    // Check authentication first
    const authCheck = checkClaudeAuth();
    if (!authCheck.authenticated) {
      console.error('Claude CLI not authenticated:', authCheck.message);
      console.error('Please run "claude setup-token" first');
      return false;
    }

    // Get Claude binary path
    try {
      this.claudeBinary = getClaudeBinaryPath();
      console.log('Using Claude binary:', this.claudeBinary);
    } catch (error) {
      console.error('Claude binary not found:', error.message);
      return false;
    }

    // Ensure expect script exists
    if (!fs.existsSync(this.expectScript)) {
      console.log('Creating expect script...');
      this.createExpectScript();
    }

    // Start periodic checks
    this.startMonitoring();

    // Initial check
    await this.checkUsage();

    console.log('Claude expect tracker initialized successfully');
    return true;
  }

  // Create the expect script if it doesn't exist
  createExpectScript() {
    const script = `#!/usr/bin/expect -f

set timeout 60
set claude_bin [lindex $argv 0]

# Start Claude CLI
spawn $claude_bin

# Wait for prompt with various patterns
expect {
    "How can I help" {
        send_user "\\nPrompt detected (help)\\n"
    }
    "desktop_bot" {
        send_user "\\nPrompt detected (desktop_bot)\\n"
    }
    "Claude Code" {
        send_user "\\nPrompt detected (Claude Code)\\n"
    }
    "Enter a prompt" {
        send_user "\\nPrompt detected (Enter prompt)\\n"
    }
    "What would you like" {
        send_user "\\nPrompt detected (What would you like)\\n"
    }
    timeout {
        send_user "\\nTimeout waiting for prompt - checking anyway\\n"
    }
}

# Send /usage command
send "/usage\\r"

# Wait for response
expect {
    -re {5-hour.*?([0-9]+)%} {
        send_user "\\n5-hour usage: $expect_out(1,string)%\\n"
    }
    -re {([0-9]+)% used} {
        send_user "\\nUsage: $expect_out(1,string)%\\n"
    }
    -re {Usage:.*?([0-9]+)%} {
        send_user "\\nUsage: $expect_out(1,string)%\\n"
    }
    timeout {
        send_user "\\nTimeout waiting for usage\\n"
    }
}

# Exit
send "exit\\r"
expect eof
`;

    fs.writeFileSync(this.expectScript, script);
    fs.chmodSync(this.expectScript, '755');
    console.log('Expect script created');
  }

  // Start monitoring with periodic checks
  startMonitoring() {
    // Check every 2 minutes
    this.checkInterval = setInterval(async () => {
      await this.checkUsage();
    }, 2 * 60 * 1000);
  }

  // Run expect script to get usage
  async checkUsage() {
    if (this.isChecking) {
      console.log('Usage check already in progress, skipping...');
      return null;
    }

    this.isChecking = true;
    console.log('Running expect script to get Claude usage...');

    return new Promise((resolve) => {
      const expectProcess = spawn('expect', [this.expectScript, this.claudeBinary], {
        env: { ...process.env }
      });

      let output = '';
      let processTimeout;

      expectProcess.stdout.on('data', (data) => {
        output += data.toString();
      });

      expectProcess.stderr.on('data', (data) => {
        output += data.toString();
      });

      // Set timeout
      processTimeout = setTimeout(() => {
        console.log('Expect script timeout after 90 seconds');
        expectProcess.kill();
      }, 90000);

      expectProcess.on('close', (code) => {
        clearTimeout(processTimeout);
        this.isChecking = false;

        console.log('Expect script completed with code:', code);

        if (output.length > 0) {
          const usage = this.parseUsageFromOutput(output);
          if (usage !== null) {
            resolve(usage);
          } else {
            console.log('Could not parse usage from expect output');
            resolve(null);
          }
        } else {
          console.log('No output from expect script');
          resolve(null);
        }
      });

      expectProcess.on('error', (error) => {
        clearTimeout(processTimeout);
        this.isChecking = false;
        console.error('Failed to run expect script:', error.message);
        resolve(null);
      });
    });
  }

  // Parse usage from expect output
  parseUsageFromOutput(output) {
    // Look for percentage patterns
    const patterns = [
      /5-hour usage:\s*(\d+)%/i,
      /Usage:\s*(\d+)%/i,
      /(\d+)%\s*used/i,
      /5-hour.*?(\d+)%/i,
      /(\d+)%/
    ];

    for (const pattern of patterns) {
      const match = output.match(pattern);
      if (match) {
        const percentage = parseInt(match[1]);
        if (percentage >= 0 && percentage <= 100) {
          console.log(`Found usage: ${percentage}%`);

          if (percentage !== this.lastUsage) {
            this.lastUsage = percentage;
            this.saveUsage(percentage);
          }

          return percentage;
        }
      }
    }

    return null;
  }

  // Save usage to file
  saveUsage(percentage) {
    const dir = path.dirname(this.usageFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const resetAt = new Date(Date.now() + 5 * 60 * 60 * 1000);

    const usageData = {
      percentage: percentage,
      pct: percentage,
      used: percentage,
      limit: 100,
      resetAt: resetAt.toISOString(),
      reset_at: resetAt.toISOString(),
      subscription: 'Claude Pro',
      type: '5-hour',
      realData: true,
      timestamp: new Date().toISOString(),
      source: 'claude-expect-tracker'
    };

    fs.writeFileSync(this.usageFile, JSON.stringify(usageData, null, 2));
    console.log(`Saved usage: ${percentage}%`);
    this.emit('usage-updated', usageData);
  }

  // Get current usage data
  getUsageData() {
    try {
      if (fs.existsSync(this.usageFile)) {
        return JSON.parse(fs.readFileSync(this.usageFile, 'utf8'));
      }
    } catch (error) {
      console.error('Error reading usage file:', error);
    }

    return {
      percentage: 0,
      used: 0,
      limit: 100,
      source: 'claude-expect-tracker'
    };
  }

  // Stop tracking
  stop() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    console.log('Claude expect tracker stopped');
  }
}

// Export for use in other modules
module.exports = ClaudeExpectTracker;

// Run as standalone if executed directly
if (require.main === module) {
  const tracker = new ClaudeExpectTracker();

  // Handle shutdown gracefully
  process.on('SIGINT', () => {
    console.log('\nShutting down tracker...');
    tracker.stop();
    process.exit(0);
  });

  // Start tracking
  tracker.start().then((success) => {
    if (success) {
      console.log('Claude Expect Tracker running... Press Ctrl+C to stop');

      // Log usage updates
      tracker.on('usage-updated', (data) => {
        console.log(`Usage updated: ${data.percentage}% | Source: ${data.source}`);
      });
    } else {
      console.error('Failed to start tracker');
      process.exit(1);
    }
  });
}