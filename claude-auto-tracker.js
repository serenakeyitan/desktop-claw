#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec, spawn } = require('child_process');
const EventEmitter = require('events');

class ClaudeAutoTracker extends EventEmitter {
  constructor() {
    super();
    this.usageFile = path.join(os.homedir(), '.alldaypoke', 'real-usage.json');
    this.sessionFile = path.join(os.homedir(), '.alldaypoke', 'claude-session.json');
    this.isTracking = false;
    this.sessionStartTime = null;
    this.totalSessionMinutes = 0;
    this.lastActivityTime = null;
    this.checkInterval = null;
    this.usageCheckInterval = null;
    this.currentUsage = 0;
    this.maxMinutesPerSession = 300; // 5 hours in minutes
  }

  // Initialize tracking
  async start() {
    console.log('Starting Claude Code automatic usage tracking...');

    // Load previous session data
    this.loadSession();

    // Start monitoring Claude process
    this.startProcessMonitoring();

    // Start periodic usage estimation
    this.startUsageEstimation();

    // Try to get initial usage from Claude if possible
    this.attemptUsageCapture();

    console.log('Automatic tracking initialized');
  }

  // Load previous session data
  loadSession() {
    try {
      if (fs.existsSync(this.sessionFile)) {
        const session = JSON.parse(fs.readFileSync(this.sessionFile, 'utf8'));
        this.totalSessionMinutes = session.totalMinutes || 0;
        this.sessionStartTime = session.sessionStart ? new Date(session.sessionStart) : null;
        console.log(`Loaded session: ${this.totalSessionMinutes} minutes used`);
      }
    } catch (error) {
      console.log('No previous session found, starting fresh');
    }
  }

  // Save session data
  saveSession() {
    const dir = path.dirname(this.sessionFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const session = {
      totalMinutes: this.totalSessionMinutes,
      sessionStart: this.sessionStartTime,
      lastUpdate: new Date().toISOString()
    };

    fs.writeFileSync(this.sessionFile, JSON.stringify(session, null, 2));
  }

  // Monitor Claude process activity
  startProcessMonitoring() {
    // Check every 30 seconds for Claude activity
    this.checkInterval = setInterval(() => {
      this.checkClaudeActivity();
    }, 30000);

    // Initial check
    this.checkClaudeActivity();
  }

  // Check if Claude is running and active
  checkClaudeActivity() {
    exec('ps aux | grep -i "claude" | grep -v grep', (error, stdout) => {
      const isRunning = stdout && stdout.includes('Claude');

      if (isRunning) {
        const now = new Date();

        if (!this.isTracking) {
          // Claude just started
          this.isTracking = true;
          this.sessionStartTime = now;
          this.lastActivityTime = now;
          console.log('Claude Code session detected - tracking started');
          this.emit('session-started');
        } else {
          // Claude is still running
          const idleMinutes = (now - this.lastActivityTime) / 60000;

          // If not idle for too long, count as active
          if (idleMinutes < 5) {
            const sessionMinutes = (now - this.sessionStartTime) / 60000;
            this.totalSessionMinutes += sessionMinutes;
            this.sessionStartTime = now;
            this.saveSession();
          }

          this.lastActivityTime = now;
        }

        // Update usage based on time
        this.updateUsageEstimate();
      } else if (this.isTracking) {
        // Claude stopped
        this.isTracking = false;
        const sessionEnd = new Date();
        const sessionMinutes = (sessionEnd - this.sessionStartTime) / 60000;
        this.totalSessionMinutes += sessionMinutes;
        this.saveSession();
        console.log(`Claude Code session ended - ${sessionMinutes.toFixed(1)} minutes tracked`);
        this.emit('session-ended', sessionMinutes);
        this.sessionStartTime = null;
      }
    });
  }

  // Estimate usage based on time
  updateUsageEstimate() {
    // Estimate: 5 hours = 100% usage
    // So 1 minute = 0.33% usage
    const estimatedPercentage = Math.min(100, (this.totalSessionMinutes / this.maxMinutesPerSession) * 100);

    if (estimatedPercentage !== this.currentUsage) {
      this.currentUsage = Math.round(estimatedPercentage);
      this.saveUsage(this.currentUsage);
      console.log(`Usage estimate updated: ${this.currentUsage}%`);
    }
  }

  // Start periodic usage estimation updates
  startUsageEstimation() {
    // Update every minute while tracking
    this.usageCheckInterval = setInterval(() => {
      if (this.isTracking) {
        this.updateUsageEstimate();
      }
    }, 60000);
  }

  // Attempt to capture actual usage from Claude
  async attemptUsageCapture() {
    try {
      // Try to run Claude usage command in background
      const usageProcess = spawn('claude', ['/usage'], {
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let output = '';
      let timeout;

      usageProcess.stdout.on('data', (data) => {
        output += data.toString();
      });

      timeout = setTimeout(() => {
        usageProcess.kill();
        this.parseUsageOutput(output);
      }, 5000);

      usageProcess.on('exit', () => {
        clearTimeout(timeout);
        this.parseUsageOutput(output);
      });
    } catch (error) {
      console.log('Could not capture Claude usage directly, using time-based estimation');
    }
  }

  // Parse usage from Claude output if possible
  parseUsageOutput(output) {
    const patterns = [
      /5-hour:\s*(\d+)%/i,
      /Usage:\s*(\d+)%/i,
      /(\d+)%\s*(?:used|of)/i
    ];

    for (const pattern of patterns) {
      const match = output.match(pattern);
      if (match) {
        const actualUsage = parseInt(match[1]);
        console.log(`Captured actual usage: ${actualUsage}%`);
        this.currentUsage = actualUsage;
        this.saveUsage(actualUsage);

        // Adjust our time tracking to match
        this.totalSessionMinutes = (actualUsage / 100) * this.maxMinutesPerSession;
        this.saveSession();
        return;
      }
    }
  }

  // Save usage to file
  saveUsage(percentage) {
    const dir = path.dirname(this.usageFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const resetAt = new Date();
    resetAt.setHours(resetAt.getHours() + 5);

    const usageData = {
      percentage: percentage,
      used: percentage,
      limit: 100,
      resetAt: resetAt.toISOString(),
      subscription: 'Claude Pro',
      type: '5-hour',
      realData: true,
      timestamp: new Date().toISOString(),
      source: 'auto-tracker',
      sessionMinutes: this.totalSessionMinutes,
      tracking: this.isTracking
    };

    fs.writeFileSync(this.usageFile, JSON.stringify(usageData, null, 2));
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
      percentage: this.currentUsage,
      used: this.currentUsage,
      limit: 100,
      tracking: this.isTracking
    };
  }

  // Reset usage counter (for new 5-hour window)
  resetUsage() {
    this.totalSessionMinutes = 0;
    this.currentUsage = 0;
    this.saveSession();
    this.saveUsage(0);
    console.log('Usage counter reset for new 5-hour window');
  }

  // Stop tracking
  stop() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }
    if (this.usageCheckInterval) {
      clearInterval(this.usageCheckInterval);
    }

    if (this.isTracking && this.sessionStartTime) {
      const sessionMinutes = (new Date() - this.sessionStartTime) / 60000;
      this.totalSessionMinutes += sessionMinutes;
      this.saveSession();
    }

    console.log('Tracking stopped');
  }
}

// Export for use in other modules
module.exports = ClaudeAutoTracker;

// Run as standalone if executed directly
if (require.main === module) {
  const tracker = new ClaudeAutoTracker();

  // Handle shutdown gracefully
  process.on('SIGINT', () => {
    console.log('\nShutting down tracker...');
    tracker.stop();
    process.exit(0);
  });

  // Start tracking
  tracker.start();

  // Log usage updates
  tracker.on('usage-updated', (data) => {
    console.log(`Usage: ${data.percentage}% | Session: ${data.sessionMinutes.toFixed(1)} minutes`);
  });

  console.log('Claude Auto Tracker running... Press Ctrl+C to stop');
}