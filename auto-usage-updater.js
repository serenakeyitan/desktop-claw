const fs = require('fs');
const path = require('path');
const os = require('os');
const ClaudeOAuthUsageTracker = require('./claude-oauth-usage-tracker');

class AutoUsageUpdater {
  constructor() {
    this.usageFile = path.join(os.homedir(), '.openclaw-pet', 'real-usage.json');
    this.updateInterval = null;
    this.claudeTracker = null;
  }

  // Initialize with Claude OAuth usage tracking
  async init() {
    console.log('Initializing Claude OAuth-based usage tracking...');

    if (!this.claudeTracker) {
      this.claudeTracker = new ClaudeOAuthUsageTracker();

      // Listen for usage updates
      this.claudeTracker.on('usage-updated', (data) => {
        console.log(`Claude OAuth tracker updated: ${data.percentage}% (5h) | Source: ${data.source}`);
        if (data.details?.seven_day) {
          console.log(`  7-day usage: ${data.details.seven_day.utilization}%`);
        }
      });

      this.claudeTracker.on('error', (err) => {
        console.error('Claude OAuth tracker error:', err.message);
      });

      // Start tracking
      const success = await this.claudeTracker.start();
      if (!success) {
        console.error('Failed to start Claude OAuth tracker');
        return false;
      }
    }

    return true;
  }

  // Get current usage from tracker
  async fetchUsage() {
    if (this.claudeTracker) {
      const data = this.claudeTracker.getUsageData();
      if (data && data.percentage !== undefined) {
        return data.percentage;
      }
    }

    // Fallback: read from saved file
    try {
      if (fs.existsSync(this.usageFile)) {
        const data = JSON.parse(fs.readFileSync(this.usageFile, 'utf8'));
        if (data.percentage !== undefined) {
          return data.percentage;
        }
      }
    } catch (e) {
      console.log('Could not read usage file:', e.message);
    }

    return null;
  }

  // Start automatic updates
  async start(intervalMinutes = 2) {
    console.log('Starting automatic Claude usage updater...');

    // Initialize the tracker
    await this.init();

    // Set up periodic updates (the tracker itself also polls, this is a backup)
    this.updateInterval = setInterval(async () => {
      await this.update();
    }, intervalMinutes * 60 * 1000);
  }

  // Perform update
  async update() {
    try {
      const usage = await this.fetchUsage();
      if (usage !== null) {
        console.log(`Claude usage: ${usage}%`);
        return true;
      }
    } catch (error) {
      console.error('Auto-update failed:', error);
    }
    return false;
  }

  // Stop automatic updates
  stop() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    if (this.claudeTracker) {
      this.claudeTracker.stop();
    }
  }
}

module.exports = AutoUsageUpdater;
