const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const os = require('os');

class OpenAIUsageFetcher extends EventEmitter {
  constructor() {
    super();
    this.usageData = null;
    this.usageFile = path.join(os.homedir(), '.alldaypoke', 'real-usage.json');
    this.checkInterval = null;
    this.authManager = null;
  }

  // Set auth manager
  setAuthManager(authManager) {
    this.authManager = authManager;
  }

  // Start fetching usage
  async start() {
    if (!this.authManager) {
      throw new Error('No auth manager set');
    }

    // Initial fetch
    await this.fetchUsage();
  }

  // Fetch usage from OpenAI API
  async fetchUsage() {
    try {
      const usage = await this.authManager.fetchUsage();

      if (usage) {
        this.usageData = usage;
        this.emit('usage-updated', usage);
        this.persistUsage();
        console.log('Fetched OpenAI usage:', usage);
      }

      return usage;
    } catch (error) {
      console.error('Failed to fetch OpenAI usage:', error);
      // Try to load from saved file
      return this.loadSavedUsage();
    }
  }

  // Get primary usage data
  getPrimaryUsage() {
    if (!this.usageData) return null;

    return {
      used: this.usageData.used,
      limit: this.usageData.limit,
      percentage: this.usageData.percentage,
      resetAt: this.usageData.resetAt,
      subscription: this.usageData.subscription,
      type: this.usageData.type,
      realData: true,
      source: 'OpenAI API'
    };
  }

  // Save usage to file
  persistUsage() {
    const usage = this.getPrimaryUsage();
    if (!usage) return;

    const payload = {
      percentage: usage.percentage,
      pct: usage.percentage,
      used: usage.used,
      limit: usage.limit,
      resetAt: usage.resetAt,
      reset_at: usage.resetAt,
      subscription: usage.subscription,
      type: usage.type,
      realData: true,
      timestamp: new Date().toISOString(),
      source: 'openai-fetcher'
    };

    try {
      const dir = path.dirname(this.usageFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.usageFile, JSON.stringify(payload, null, 2));
      console.log('Persisted OpenAI usage data');
    } catch (error) {
      console.error('Failed to persist usage data:', error);
    }
  }

  // Load saved usage from file
  loadSavedUsage() {
    try {
      if (fs.existsSync(this.usageFile)) {
        const data = JSON.parse(fs.readFileSync(this.usageFile, 'utf8'));
        const timestamp = data.timestamp ? new Date(data.timestamp) : new Date(0);
        const age = Date.now() - timestamp.getTime();

        // Use saved data if less than 6 hours old
        if (age < 6 * 60 * 60 * 1000) {
          this.usageData = data;
          return data;
        }
      }
    } catch (error) {
      console.error('Failed to load saved usage:', error);
    }
    return null;
  }

  // Start periodic checking
  startPeriodicCheck(intervalMinutes = 5) {
    // Initial check
    this.fetchUsage().catch((error) => {
      console.error('Initial usage fetch failed:', error.message);
    });

    // Set up periodic checks
    this.checkInterval = setInterval(async () => {
      try {
        await this.fetchUsage();
      } catch (error) {
        console.error('Failed to fetch usage:', error);
      }
    }, intervalMinutes * 60 * 1000);
  }

  // Stop periodic checking
  stop() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }
}

module.exports = OpenAIUsageFetcher;