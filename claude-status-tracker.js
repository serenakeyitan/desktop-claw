#!/usr/bin/env node

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const EventEmitter = require('events');
const log = require('./logger');

class ClaudeStatusTracker extends EventEmitter {
  constructor() {
    super();
    this.usageFile = path.join(os.homedir(), '.alldaypoke', 'real-usage.json');
    this.sessionFile = path.join(os.homedir(), '.alldaypoke', 'claude-status-session.json');
    this.checkInterval = null;
    this.claudeBinary = '/opt/homebrew/bin/claude';
    this.lastStatusData = null;
    this.isChecking = false;
  }

  // Start tracking
  async start() {
    log('Starting Claude Code /status automatic tracking...');

    // Load previous session if exists
    this.loadSession();

    // Start periodic status checks
    this.startMonitoring();

    // Initial status check
    await this.checkStatus();

    log('Claude /status tracking initialized');
  }

  // Load previous session data
  loadSession() {
    try {
      if (fs.existsSync(this.sessionFile)) {
        const session = JSON.parse(fs.readFileSync(this.sessionFile, 'utf8'));
        this.lastStatusData = session.lastStatus || null;
        log('Loaded previous status session');
      }
    } catch (error) {
      log('No previous session found');
    }
  }

  // Save session data
  saveSession() {
    const dir = path.dirname(this.sessionFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const session = {
      lastStatus: this.lastStatusData,
      lastUpdate: new Date().toISOString()
    };

    fs.writeFileSync(this.sessionFile, JSON.stringify(session, null, 2));
  }

  // Start monitoring with periodic checks
  startMonitoring() {
    // Check every 30 seconds
    this.checkInterval = setInterval(async () => {
      await this.checkStatus();
    }, 30000);
  }

  // Run /status command and parse output
  async checkStatus() {
    if (this.isChecking) {
      log('Status check already in progress, skipping...');
      return;
    }

    this.isChecking = true;
    log('Checking Claude /status...');

    return new Promise((resolve) => {
      const statusProcess = spawn(this.claudeBinary, ['/status'], {
        env: { ...process.env },
        timeout: 60000  // Increased from 5s to 60s for Claude initialization
      });

      let stdout = '';
      let stderr = '';
      let processTimeout;

      statusProcess.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      statusProcess.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      // Set timeout to kill process if it hangs
      processTimeout = setTimeout(() => {
        log('Status check timed out after 60 seconds, killing process...');
        statusProcess.kill();
      }, 60000);  // Increased from 5s to 60s

      statusProcess.on('close', (code) => {
        clearTimeout(processTimeout);
        this.isChecking = false;

        if (stdout) {
          log('Got status output:', stdout);
          this.parseStatusOutput(stdout);
        } else if (stderr) {
          log('Status error output:', stderr);
          // Try to parse error output in case it contains usage info
          this.parseStatusOutput(stderr);
        } else {
          log('No output from /status command');
        }

        resolve();
      });

      statusProcess.on('error', (error) => {
        clearTimeout(processTimeout);
        this.isChecking = false;
        log.error('Failed to run /status:', error.message);
        resolve();
      });
    });
  }

  // Parse the /status output
  parseStatusOutput(output) {
    try {
      // Remove ANSI escape sequences
      const cleanOutput = output.replace(/\x1b\[[0-9;]*m/g, '');

      log('Parsing status output...');

      // Look for various patterns that might contain usage info
      const patterns = [
        // Pattern for "Usage: X%" or "X% used"
        /(?:Usage|Used):\s*(\d+(?:\.\d+)?)\s*%/i,
        /(\d+(?:\.\d+)?)\s*%\s*(?:used|of|usage)/i,

        // Pattern for "X/Y messages" or similar
        /(\d+)\s*\/\s*(\d+)\s*(?:messages|requests|queries)/i,

        // Pattern for "5-hour: X%" or "3-hour: X%"
        /(?:5-hour|3-hour|hourly):\s*(\d+(?:\.\d+)?)\s*%/i,

        // Pattern for subscription info
        /(?:Subscription|Plan):\s*([\w\s]+)/i,

        // Pattern for reset time
        /(?:Reset|Resets).*?(\d+:\d+|\d+h\s*\d+m)/i,

        // Pattern for API usage percentage
        /API\s*(?:Usage|Limit):\s*(\d+(?:\.\d+)?)\s*%/i,

        // Pattern for tokens or credits
        /(\d+)\s*(?:tokens|credits)\s*(?:remaining|used|left)/i
      ];

      let usagePercentage = null;
      let messagesUsed = null;
      let messageLimit = null;
      let subscription = null;
      let resetInfo = null;

      for (const pattern of patterns) {
        const match = cleanOutput.match(pattern);
        if (match) {
          log(`Matched pattern: ${pattern}, Result: ${match[0]}`);

          // Extract percentage
          if (pattern.toString().includes('%') && match[1]) {
            usagePercentage = parseFloat(match[1]);
          }

          // Extract message count
          if (match[2] && pattern.toString().includes('messages')) {
            messagesUsed = parseInt(match[1]);
            messageLimit = parseInt(match[2]);
            if (!usagePercentage && messageLimit > 0) {
              usagePercentage = (messagesUsed / messageLimit) * 100;
            }
          }

          // Extract subscription type
          if (pattern.toString().includes('Subscription')) {
            subscription = match[1].trim();
          }

          // Extract reset info
          if (pattern.toString().includes('Reset')) {
            resetInfo = match[1];
          }
        }
      }

      // Also check for JSON data in output
      const jsonMatch = cleanOutput.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const jsonData = JSON.parse(jsonMatch[0]);
          log('Found JSON data:', jsonData);

          if (jsonData.usage !== undefined) {
            usagePercentage = jsonData.usage;
          }
          if (jsonData.percentage !== undefined) {
            usagePercentage = jsonData.percentage;
          }
          if (jsonData.messages_used !== undefined) {
            messagesUsed = jsonData.messages_used;
          }
          if (jsonData.message_limit !== undefined) {
            messageLimit = jsonData.message_limit;
          }
        } catch (e) {
          // Not valid JSON, ignore
        }
      }

      // If we found usage data, save it
      if (usagePercentage !== null) {
        log(`Extracted usage: ${usagePercentage}%`);
        this.saveUsage(usagePercentage, {
          messagesUsed,
          messageLimit,
          subscription,
          resetInfo
        });
      } else {
        log('Could not extract usage percentage from status output');

        // Save raw output for debugging
        const debugFile = path.join(os.homedir(), '.alldaypoke', 'last-status-output.txt');
        fs.writeFileSync(debugFile, output);
        log(`Saved raw output to ${debugFile} for debugging`);
      }

      this.lastStatusData = {
        output: cleanOutput,
        timestamp: new Date().toISOString()
      };
      this.saveSession();

    } catch (error) {
      log.error('Error parsing status output:', error);
    }
  }

  // Save usage to file
  saveUsage(percentage, additionalInfo = {}) {
    const dir = path.dirname(this.usageFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Calculate reset time (5 hours for Claude Pro)
    const resetAt = new Date();
    resetAt.setHours(resetAt.getHours() + 5);

    const usageData = {
      percentage: Math.round(percentage),
      used: percentage,
      limit: 100,
      resetAt: resetAt.toISOString(),
      subscription: additionalInfo.subscription || 'Claude Pro',
      type: '5-hour',
      realData: true,
      timestamp: new Date().toISOString(),
      source: 'claude-status',
      ...additionalInfo
    };

    fs.writeFileSync(this.usageFile, JSON.stringify(usageData, null, 2));

    log(`Saved usage: ${percentage}%`);
    this.emit('usage-updated', usageData);
  }

  // Get current usage data
  getUsageData() {
    try {
      if (fs.existsSync(this.usageFile)) {
        return JSON.parse(fs.readFileSync(this.usageFile, 'utf8'));
      }
    } catch (error) {
      log.error('Error reading usage file:', error);
    }

    return {
      percentage: 0,
      used: 0,
      limit: 100,
      source: 'claude-status'
    };
  }

  // Stop tracking
  stop() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }
    this.saveSession();
    log('Claude /status tracking stopped');
  }
}

// Export for use in other modules
module.exports = ClaudeStatusTracker;

// Run as standalone if executed directly
if (require.main === module) {
  const tracker = new ClaudeStatusTracker();

  // Handle shutdown gracefully
  process.on('SIGINT', () => {
    log('\nShutting down tracker...');
    tracker.stop();
    process.exit(0);
  });

  // Start tracking
  tracker.start();

  // Log usage updates
  tracker.on('usage-updated', (data) => {
    log(`Usage updated: ${data.percentage}% | Source: ${data.source}`);
  });

  log('Claude /status Tracker running... Press Ctrl+C to stop');
}