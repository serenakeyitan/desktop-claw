const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const ClaudeExpectTracker = require('./claude-expect-tracker');

class AutoUsageUpdater {
  constructor() {
    this.usageFile = path.join(os.homedir(), '.openclaw-pet', 'real-usage.json');
    this.updateInterval = null;
    this.claudeTracker = null;
  }

  // Initialize with automatic Claude expect tracking
  async init() {
    console.log('Initializing automatic Claude Code expect-based usage tracking...');

    // Start the Claude expect auto-tracker
    if (!this.claudeTracker) {
      this.claudeTracker = new ClaudeExpectTracker();

      // Listen for usage updates
      this.claudeTracker.on('usage-updated', (data) => {
        console.log(`Claude expect tracker updated: ${data.percentage}% | Source: ${data.source}`);
      });

      // Start tracking
      const success = await this.claudeTracker.start();
      if (!success) {
        console.error('Failed to start Claude expect tracker');
        return false;
      }
    }

    return true;
  }

  // Get current usage from auto-tracker
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

    // No usage data available
    return null;
  }

  // Start automatic updates
  async start(intervalMinutes = 2) {
    console.log('Starting automatic ChatGPT usage updater...');

    // Initialize the tracker
    await this.init();

    // Set up periodic updates
    this.updateInterval = setInterval(async () => {
      await this.update();
    }, intervalMinutes * 60 * 1000);
  }

  // Perform update
  async update() {
    try {
      const usage = await this.fetchUsage();
      if (usage !== null) {
        console.log(`ChatGPT usage: ${usage}%`);
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