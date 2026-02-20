const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Local usage tracking for Claude subscriptions
class UsageTracker extends EventEmitter {
  constructor() {
    super();
    this.dataFile = path.join(os.homedir(), '.openclaw-pet', 'usage-data.json');
    this.usage = this.loadUsage();
    this.resetIfNeeded();
  }

  // Load saved usage data
  loadUsage() {
    try {
      if (fs.existsSync(this.dataFile)) {
        const data = JSON.parse(fs.readFileSync(this.dataFile, 'utf8'));
        return {
          messagesUsed: data.messagesUsed || 0,
          lastReset: new Date(data.lastReset || Date.now()),
          dailyMessages: data.dailyMessages || [],
          subscription: data.subscription || 'Claude Pro'
        };
      }
    } catch (error) {
      console.error('Error loading usage data:', error);
    }

    return {
      messagesUsed: 0,
      lastReset: new Date(),
      dailyMessages: [],
      subscription: 'Claude Pro'
    };
  }

  // Save usage data
  saveUsage() {
    try {
      const dir = path.dirname(this.dataFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.dataFile, JSON.stringify(this.usage, null, 2));
    } catch (error) {
      console.error('Error saving usage data:', error);
    }
  }

  // Check if we need to reset (daily reset)
  resetIfNeeded() {
    const now = new Date();
    const lastReset = new Date(this.usage.lastReset);

    // Reset if it's a new day
    if (now.getDate() !== lastReset.getDate() ||
        now.getMonth() !== lastReset.getMonth() ||
        now.getFullYear() !== lastReset.getFullYear()) {

      console.log('Resetting daily usage counter');
      this.usage.messagesUsed = 0;
      this.usage.lastReset = now;
      this.usage.dailyMessages = [];
      this.saveUsage();
    }
  }

  // Track a new message
  trackMessage(type = 'api_call') {
    this.resetIfNeeded();

    this.usage.messagesUsed++;
    this.usage.dailyMessages.push({
      timestamp: new Date().toISOString(),
      type: type
    });

    this.saveUsage();
    this.emit('usage-updated', this.getUsageData());
  }

  // Get usage data in the format expected by the UI
  getUsageData() {
    // Claude Pro typically has these limits
    const limits = {
      'Claude Pro': 100,  // Estimated based on typical Pro limits
      'Claude Team': 200, // Estimated for Team plans
      'Claude Free': 10   // Estimated for free tier
    };

    const limit = limits[this.usage.subscription] || 100;
    const used = this.usage.messagesUsed;
    const remaining = Math.max(0, limit - used);
    const percentage = Math.min(100, Math.round((used / limit) * 100));

    // Calculate reset time (midnight local time)
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);

    return {
      used: used,
      limit: limit,
      remaining: remaining,
      percentage: percentage,
      resetAt: tomorrow.toISOString(),
      subscription: this.usage.subscription,
      type: 'messages',
      realTracking: true // Indicate this is real local tracking
    };
  }

  // Set subscription type
  setSubscription(subscription) {
    this.usage.subscription = subscription;
    this.saveUsage();
  }

  // Get message history for today
  getTodayMessages() {
    return this.usage.dailyMessages;
  }

  // Manual reset
  reset() {
    this.usage.messagesUsed = 0;
    this.usage.dailyMessages = [];
    this.usage.lastReset = new Date();
    this.saveUsage();
    this.emit('usage-updated', this.getUsageData());
  }

  // Update with real usage data from ClaudeUsageFetcher
  setRealUsage(realUsageData) {
    if (realUsageData && realUsageData.used !== undefined) {
      console.log('Updating with real usage data:', realUsageData);
      this.usage.messagesUsed = realUsageData.used;
      this.usage.subscription = realUsageData.subscription || this.usage.subscription;

      // Save the real data
      this.saveUsage();

      // Emit the real data
      this.emit('usage-updated', realUsageData);
    }
  }
}

module.exports = UsageTracker;