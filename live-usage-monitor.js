#!/usr/bin/env node

const pty = require('node-pty');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { getClaudeBinaryPath } = require('./claude-path');

class LiveUsageMonitor {
  constructor() {
    this.usageFile = path.join(os.homedir(), '.alldaypoke', 'real-usage.json');
    this.ptyProcess = null;
    this.output = '';
    this.lastUsage = null;
    this.claudeBinary = null;
  }

  // Clean ANSI codes from terminal output
  stripAnsi(str) {
    return str.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '')
              .replace(/\u001b\[[0-9]+[GKJ]/g, '')
              .replace(/\u001b\[[0-9;]*m/g, '')
              .replace(/\r/g, '');
  }

  // Start PTY session with Claude
  async startSession() {
    return new Promise((resolve, reject) => {
      console.log('Starting live Claude Code session...');
      let claudeBinary;
      try {
        claudeBinary = this.ensureClaudeBinary();
      } catch (error) {
        reject(error);
        return;
      }

      // Create a pseudo-terminal
      this.ptyProcess = pty.spawn(claudeBinary, [], {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: process.cwd(),
        env: { ...process.env, TERM: 'xterm-256color' }
      });

      let sessionReady = false;
      let timeout;

      this.ptyProcess.on('data', (data) => {
        this.output += data;
        const cleaned = this.stripAnsi(this.output);

        // Debug output
        if (!sessionReady && cleaned.length > 0) {
          console.log('Session output detected, length:', cleaned.length);
        }

        // Check if we're at the prompt
        const promptPatterns = [
          'How can I help',
          'desktop_bot',
          'Claude Code',
          'Enter a prompt',
          'What would you like',
          'Ready to assist',
          'Available commands',
          'Type /help',
          'Welcome to Claude'
        ];

        const hasPromptPattern = promptPatterns.some(pattern => cleaned.includes(pattern));
        const hasPromptChar = cleaned.trim().endsWith('>') || cleaned.trim().endsWith('$') || cleaned.trim().endsWith('#');
        const hasSubstantialOutput = cleaned.length > 100;

        if (!sessionReady && (hasPromptPattern || hasPromptChar || hasSubstantialOutput)) {
          sessionReady = true;
          clearTimeout(timeout);
          console.log('Claude session ready!');
          resolve(true);
        }

        // Look for usage in the output
        if (sessionReady && cleaned.includes('%')) {
          this.parseUsage(cleaned);
        }
      });

      this.ptyProcess.on('exit', (code) => {
        console.log('Claude session ended with code:', code);
        this.ptyProcess = null;
      });

      // Timeout if session doesn't start
      timeout = setTimeout(() => {
        if (!sessionReady) {
          console.log('Session timeout after 60 seconds - Claude may not be available');
          this.stop();
          reject(new Error('Failed to start Claude session'));
        }
      }, 60000);  // Increased from 10s to 60s for Claude initialization
    });
  }

  ensureClaudeBinary() {
    if (!this.claudeBinary) {
      this.claudeBinary = getClaudeBinaryPath();
      console.log('Using Claude CLI binary:', this.claudeBinary);
    }
    return this.claudeBinary;
  }

  // Parse usage from output
  parseUsage(text) {
    const patterns = [
      /5-hour:\s*(\d+)%/i,
      /Model usage:\s*(\d+)%/i,
      /Usage:\s*(\d+)%/i,
      /(\d+)%\s*(?:used|of)/i,
      /Current usage:\s*(\d+)%/i
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        const percentage = parseInt(match[1]);
        if (percentage !== this.lastUsage) {
          console.log(`📊 Found usage: ${percentage}%`);
          this.lastUsage = percentage;
          this.saveUsage(percentage);
        }
        return percentage;
      }
    }

    // Try to find any percentage
    const anyPercent = text.match(/(\d+)%/);
    if (anyPercent) {
      const percentage = parseInt(anyPercent[1]);
      if (percentage >= 0 && percentage <= 100 && percentage !== this.lastUsage) {
        console.log(`📊 Found usage: ${percentage}%`);
        this.lastUsage = percentage;
        this.saveUsage(percentage);
        return percentage;
      }
    }

    return null;
  }

  // Send /usage command
  async checkUsage() {
    if (!this.ptyProcess) {
      console.log('No active session');
      return null;
    }

    console.log('Checking usage...');
    this.output = ''; // Clear buffer
    this.ptyProcess.write('/usage\r');

    // Wait for response
    return new Promise((resolve) => {
      setTimeout(() => {
        const cleaned = this.stripAnsi(this.output);
        const usage = this.parseUsage(cleaned);
        if (usage !== null) {
          resolve(usage);
        } else {
          console.log('Could not parse usage from output');
          // Debug: show what we got
          if (cleaned.length > 0 && cleaned.length < 500) {
            console.log('Output sample:', cleaned.substring(0, 200));
          }
          resolve(null);
        }
      }, 3000); // Wait 3 seconds for response
    });
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
      used: percentage,
      limit: 100,
      resetAt: resetAt.toISOString(),
      subscription: 'Claude Pro',
      type: '5-hour',
      realData: true,
      timestamp: new Date().toISOString(),
      source: 'live-monitor'
    };

    fs.writeFileSync(this.usageFile, JSON.stringify(usageData, null, 2));
    console.log(`✅ Saved usage to file: ${percentage}%`);
  }

  // Start continuous monitoring
  async startMonitoring(intervalMinutes = 2) {
    try {
      // Start the Claude session
      await this.startSession();

      // Do initial check
      await this.checkUsage();

      // Set up periodic checks
      this.monitorInterval = setInterval(async () => {
        await this.checkUsage();
      }, intervalMinutes * 60 * 1000);

      console.log(`📡 Live monitoring started (checking every ${intervalMinutes} minutes)`);
      console.log('Press Ctrl+C to stop');

    } catch (error) {
      console.error('Failed to start monitoring:', error.message);
      process.exit(1);
    }
  }

  // Stop monitoring
  stop() {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
    }
    if (this.ptyProcess) {
      this.ptyProcess.write('exit\r');
      setTimeout(() => {
        if (this.ptyProcess) {
          this.ptyProcess.kill();
        }
      }, 1000);
    }
    console.log('Monitoring stopped');
  }
}

// Main execution
if (require.main === module) {
  const monitor = new LiveUsageMonitor();

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    monitor.stop();
    process.exit(0);
  });

  // Start monitoring
  monitor.startMonitoring(1); // Check every 1 minute
}

module.exports = LiveUsageMonitor;
