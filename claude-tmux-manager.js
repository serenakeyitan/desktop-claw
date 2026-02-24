#!/usr/bin/env node

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const EventEmitter = require('events');
const { getClaudeBinaryPath, checkClaudeAuth } = require('./claude-path');

class ClaudeTmuxManager extends EventEmitter {
  constructor() {
    super();
    this.usageFile = path.join(os.homedir(), '.alldaypoke', 'real-usage.json');
    this.sessionName = 'claude-usage-tracker';
    this.claudeBinary = null;
    this.checkInterval = null;
    this.lastUsage = null;
    this.isSessionActive = false;
  }

  // Check if tmux is available
  checkTmuxAvailable() {
    try {
      const result = spawnSync('which', ['tmux'], { encoding: 'utf8' });
      if (result.status === 0) {
        console.log('tmux is available');
        return true;
      }
    } catch (error) {
      console.error('tmux not found:', error.message);
    }
    return false;
  }

  // Start the tmux-based tracker
  async start() {
    console.log('Starting Claude Code tmux-based usage tracking...');

    // Check tmux availability
    if (!this.checkTmuxAvailable()) {
      console.error('tmux is not installed. Please install tmux first.');
      console.error('On macOS: brew install tmux');
      console.error('On Linux: sudo apt-get install tmux');
      return false;
    }

    // Check authentication
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

    // Create or attach to tmux session
    await this.createTmuxSession();

    // Start periodic checks
    this.startMonitoring();

    // Initial check
    await this.checkUsage();

    console.log('Claude tmux manager initialized successfully');
    return true;
  }

  // Create or attach to tmux session
  async createTmuxSession() {
    return new Promise((resolve) => {
      // Check if session already exists
      const checkSession = spawnSync('tmux', ['has-session', '-t', this.sessionName], {
        encoding: 'utf8'
      });

      if (checkSession.status !== 0) {
        // Create new session
        console.log('Creating new tmux session...');
        const createSession = spawnSync('tmux', [
          'new-session',
          '-d',
          '-s', this.sessionName,
          this.claudeBinary
        ], {
          encoding: 'utf8'
        });

        if (createSession.status === 0) {
          console.log('tmux session created successfully');
          this.isSessionActive = true;

          // Wait for Claude to initialize
          setTimeout(() => {
            resolve(true);
          }, 5000);
        } else {
          console.error('Failed to create tmux session');
          resolve(false);
        }
      } else {
        console.log('tmux session already exists');
        this.isSessionActive = true;
        resolve(true);
      }
    });
  }

  // Send command to tmux session
  sendCommand(command) {
    return new Promise((resolve) => {
      const sendKeys = spawnSync('tmux', [
        'send-keys',
        '-t', this.sessionName,
        command,
        'C-m'
      ], {
        encoding: 'utf8'
      });

      if (sendKeys.status === 0) {
        console.log(`Sent command: ${command}`);
        resolve(true);
      } else {
        console.error('Failed to send command to tmux session');
        resolve(false);
      }
    });
  }

  // Capture pane content
  capturePaneContent() {
    const capture = spawnSync('tmux', [
      'capture-pane',
      '-t', this.sessionName,
      '-p'
    ], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 // 1MB buffer
    });

    if (capture.status === 0) {
      return capture.stdout || '';
    }

    console.error('Failed to capture pane content');
    return '';
  }

  // Start monitoring with periodic checks
  startMonitoring() {
    // Check every 2 minutes
    this.checkInterval = setInterval(async () => {
      await this.checkUsage();
    }, 2 * 60 * 1000);
  }

  // Check usage via tmux session
  async checkUsage() {
    if (!this.isSessionActive) {
      console.log('tmux session not active');
      return null;
    }

    console.log('Checking Claude usage via tmux...');

    // Clear the pane first
    await this.sendCommand('clear');

    // Wait a moment
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Send /usage command
    await this.sendCommand('/usage');

    // Wait for response
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Capture output
    const output = this.capturePaneContent();

    if (output) {
      const usage = this.parseUsageFromOutput(output);
      if (usage !== null) {
        return usage;
      }
    }

    console.log('Could not get usage from tmux session');
    return null;
  }

  // Parse usage from output
  parseUsageFromOutput(output) {
    // Remove ANSI codes
    const cleanOutput = output.replace(/\x1b\[[0-9;]*m/g, '');

    // Look for percentage patterns
    const patterns = [
      /5-hour.*?(\d+)%/i,
      /(\d+)%\s*used/i,
      /Usage.*?(\d+)%/i,
      /Model usage.*?(\d+)%/i,
      /Current usage.*?(\d+)%/i,
      /(\d+)%/
    ];

    for (const pattern of patterns) {
      const match = cleanOutput.match(pattern);
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

    // Also check for message count pattern
    const messagePattern = /(\d+)\s*\/\s*(\d+)\s*messages/i;
    const messageMatch = cleanOutput.match(messagePattern);
    if (messageMatch) {
      const used = parseInt(messageMatch[1]);
      const limit = parseInt(messageMatch[2]);
      const percentage = Math.round((used / limit) * 100);

      console.log(`Found message usage: ${used}/${limit} (${percentage}%)`);

      if (percentage !== this.lastUsage) {
        this.lastUsage = percentage;
        this.saveUsage(percentage);
      }

      return percentage;
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
      source: 'claude-tmux-manager'
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
      source: 'claude-tmux-manager'
    };
  }

  // Kill tmux session
  killSession() {
    if (this.isSessionActive) {
      const kill = spawnSync('tmux', ['kill-session', '-t', this.sessionName], {
        encoding: 'utf8'
      });

      if (kill.status === 0) {
        console.log('tmux session killed');
      } else {
        console.log('Failed to kill tmux session');
      }

      this.isSessionActive = false;
    }
  }

  // Stop tracking
  stop() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }

    // Optionally keep the session running for future use
    // this.killSession();

    console.log('Claude tmux manager stopped');
  }
}

// Export for use in other modules
module.exports = ClaudeTmuxManager;

// Run as standalone if executed directly
if (require.main === module) {
  const manager = new ClaudeTmuxManager();

  // Handle shutdown gracefully
  process.on('SIGINT', () => {
    console.log('\nShutting down manager...');
    manager.stop();
    // Optionally kill the session on exit
    manager.killSession();
    process.exit(0);
  });

  // Start tracking
  manager.start().then((success) => {
    if (success) {
      console.log('Claude Tmux Manager running... Press Ctrl+C to stop');

      // Log usage updates
      manager.on('usage-updated', (data) => {
        console.log(`Usage updated: ${data.percentage}% | Source: ${data.source}`);
      });
    } else {
      console.error('Failed to start manager');
      process.exit(1);
    }
  });
}