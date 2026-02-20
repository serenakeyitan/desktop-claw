const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

class AutoUsageUpdater {
  constructor() {
    this.usageFile = path.join(os.homedir(), '.openclaw-pet', 'real-usage.json');
    this.updateInterval = null;
  }

  // Try multiple methods to get usage from Claude Code
  async fetchUsage() {
    console.log('Auto-fetching usage from Claude Code...');

    // Method 1: Use expect script if available
    try {
      const expectScript = path.join(__dirname, 'get-claude-usage.exp');
      if (fs.existsSync(expectScript)) {
        const output = await this.runCommand(`expect ${expectScript}`);
        if (output) {
          const usage = this.parseUsage(output);
          if (usage) return usage;
        }
      }
    } catch (e) {
      console.log('Expect method failed:', e.message);
    }

    // Method 2: Try Python script
    try {
      const pythonScript = path.join(__dirname, 'fetch-claude-usage.py');
      if (fs.existsSync(pythonScript)) {
        const output = await this.runCommand(`python3 ${pythonScript}`);
        // Check if file was updated
        if (fs.existsSync(this.usageFile)) {
          const data = JSON.parse(fs.readFileSync(this.usageFile, 'utf8'));
          if (data.percentage) return data.percentage;
        }
      }
    } catch (e) {
      console.log('Python method failed:', e.message);
    }

    // Method 3: Try direct command with timeout
    try {
      const output = await this.runCommand('echo "/usage" | timeout 5 claude 2>&1 || true');
      if (output) {
        const usage = this.parseUsage(output);
        if (usage) return usage;
      }
    } catch (e) {
      console.log('Direct method failed:', e.message);
    }

    // Method 4: Try using printf with newlines
    try {
      const output = await this.runCommand('printf "/usage\\nexit\\n" | claude 2>&1 | head -50');
      if (output) {
        const usage = this.parseUsage(output);
        if (usage) return usage;
      }
    } catch (e) {
      console.log('Printf method failed:', e.message);
    }

    return null;
  }

  // Run command and return output
  runCommand(command) {
    return new Promise((resolve) => {
      exec(command, {
        timeout: 10000,
        maxBuffer: 1024 * 1024
      }, (error, stdout, stderr) => {
        if (stdout) resolve(stdout);
        else if (stderr) resolve(stderr);
        else resolve(null);
      });
    });
  }

  // Parse usage from output
  parseUsage(output) {
    if (!output) return null;

    // Look for percentage patterns
    const patterns = [
      /5-hour:\s*(\d+)%/i,
      /Model usage:\s*(\d+)%/i,
      /Usage:\s*(\d+)%/i,
      /Current usage:\s*(\d+)%/i,
      /(\d+)%\s*(?:used|of)/i
    ];

    for (const pattern of patterns) {
      const match = output.match(pattern);
      if (match && match[1]) {
        const percentage = parseInt(match[1]);
        console.log(`Found usage: ${percentage}%`);
        return percentage;
      }
    }

    // Try to find any percentage
    const anyPercent = output.match(/(\d+)%/);
    if (anyPercent) {
      return parseInt(anyPercent[1]);
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
      used: percentage,
      limit: 100,
      resetAt: resetAt.toISOString(),
      subscription: 'Claude Pro',
      type: '5-hour',
      realData: true,
      timestamp: new Date().toISOString(),
      source: 'auto-updater'
    };

    fs.writeFileSync(this.usageFile, JSON.stringify(usageData, null, 2));

    console.log(`✅ Auto-updated usage to ${percentage}%`);
    return usageData;
  }

  // Start automatic updates
  async start(intervalMinutes = 5) {
    console.log('Starting automatic usage updater...');

    // Do initial update
    await this.update();

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
        this.saveUsage(usage);
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
  }
}

module.exports = AutoUsageUpdater;