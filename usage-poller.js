const https = require('https');
const EventEmitter = require('events');

class UsagePoller extends EventEmitter {
  constructor(authManager, pollIntervalSeconds = 30) {
    super();
    this.authManager = authManager;
    this.pollInterval = pollIntervalSeconds * 1000;
    this.polling = false;
    this.pollTimer = null;
    this.lastTokenUsage = null;
    this.backoffTime = 0;
    this.maxBackoff = 300000; // 5 minutes max backoff
    this.demoMode = !authManager || (!authManager.apiKey && !authManager.accessToken);
    this.demoData = {
      used: 45000,
      limit: 100000,
      resetAt: null
    };

    // Different endpoints for different auth methods
    this.endpoints = {
      apiKey: '/v1/dashboard/usage',
      oauth: '/v1/usage/current',
      admin: '/v1/admin/usage' // For enterprise/admin API
    };
  }

  start() {
    if (this.polling) return;

    this.polling = true;
    this.poll(); // Initial poll

    // Set up regular polling
    this.pollTimer = setInterval(() => {
      if (this.polling) {
        this.poll();
      }
    }, this.pollInterval);
  }

  stop() {
    this.polling = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async poll() {
    try {
      // Demo mode for testing
      if (this.demoMode) {
        this.handleDemoMode();
        return;
      }

      const data = await this.fetchUsage();
      this.handleUsageData(data);
      this.backoffTime = 0; // Reset backoff on success
    } catch (error) {
      this.handleError(error);
    }
  }

  handleDemoMode() {
    // Simulate token usage changes
    if (Math.random() > 0.7) {
      this.demoData.used = Math.min(this.demoData.limit, this.demoData.used + Math.floor(Math.random() * 1000));
    }

    // Set reset time to 4 hours from now if not set
    if (!this.demoData.resetAt) {
      const resetTime = new Date();
      resetTime.setHours(resetTime.getHours() + 4);
      this.demoData.resetAt = resetTime.toISOString();
    }

    const pct = Math.round((this.demoData.used / this.demoData.limit) * 100);

    this.emit('update', {
      used: this.demoData.used,
      limit: this.demoData.limit,
      pct: pct,
      reset_at: this.demoData.resetAt,
      demo: true
    });

    // Simulate activity sometimes
    if (Math.random() > 0.8) {
      this.emit('activity');
    }
  }

  fetchUsage() {
    return new Promise((resolve, reject) => {
      // Determine endpoint based on auth method
      let endpoint = this.endpoints.apiKey;
      if (this.authManager) {
        if (this.authManager.authMethod === 'oauth') {
          endpoint = this.endpoints.oauth;
        }
      }

      // Get auth headers
      let headers;
      try {
        headers = this.authManager ? this.authManager.getAuthHeaders() : {
          'x-api-key': 'demo',
          'anthropic-version': '2023-06-01'
        };
        headers['Content-Type'] = 'application/json';
      } catch (error) {
        reject(error);
        return;
      }

      const options = {
        hostname: 'api.anthropic.com',
        port: 443,
        path: endpoint,
        method: 'GET',
        headers: headers
      };

      const req = https.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const parsed = JSON.parse(data);
              resolve(parsed);
            } catch (error) {
              reject(new Error('Invalid JSON response'));
            }
          } else if (res.statusCode === 429) {
            reject(new Error('Rate limited'));
          } else if (res.statusCode === 401) {
            reject(new Error('Authentication failed'));
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on('error', (error) => {
        reject(error);
      });

      req.end();
    });
  }

  handleUsageData(data) {
    // Parse Anthropic API response - handles multiple formats
    let used = 0;
    let limit = 0;
    let resetAt = null;
    let tier = null;

    // Handle different response formats based on endpoint
    if (data.usage_snapshot) {
      // OAuth endpoint format
      const snapshot = data.usage_snapshot;
      used = snapshot.tokens_used || 0;
      limit = snapshot.tokens_limit || 1000000;
      resetAt = snapshot.reset_at || snapshot.period_end;
      tier = snapshot.tier || 'standard';
    } else if (data.usage) {
      // API key endpoint format
      if (typeof data.usage === 'object') {
        used = (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0);
      } else {
        used = data.usage;
      }
      limit = data.limit || data.rate_limit?.tokens || 1000000;
      resetAt = data.reset_at || data.rate_limit?.reset_at;
    } else if (data.current_usage !== undefined) {
      // Alternative format
      used = data.current_usage;
      limit = data.max_usage || data.token_limit || 1000000;
      resetAt = data.resets_at || data.reset_time;
    } else if (data.tokens) {
      // Token-based format
      used = data.tokens.used || 0;
      limit = data.tokens.limit || 1000000;
      resetAt = data.tokens.reset_at;
    }

    // Handle rate limit headers if no explicit data
    if (data.headers) {
      if (data.headers['x-ratelimit-limit-tokens']) {
        limit = parseInt(data.headers['x-ratelimit-limit-tokens']);
      }
      if (data.headers['x-ratelimit-remaining-tokens']) {
        const remaining = parseInt(data.headers['x-ratelimit-remaining-tokens']);
        if (limit > 0) {
          used = limit - remaining;
        }
      }
      if (data.headers['x-ratelimit-reset']) {
        resetAt = data.headers['x-ratelimit-reset'];
      }
    }

    // Default reset time if not provided
    if (!resetAt) {
      // Calculate next reset (usually start of next month)
      const now = new Date();
      const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      resetAt = nextMonth.toISOString();
    }

    // Calculate percentage
    const pct = limit > 0 ? Math.round((used / limit) * 100) : 0;

    // Detect activity (token usage increased)
    if (this.lastTokenUsage !== null && used > this.lastTokenUsage) {
      this.emit('activity');
    }
    this.lastTokenUsage = used;

    // Emit update
    this.emit('update', {
      used,
      limit,
      pct,
      reset_at: resetAt,
      cached: false
    });
  }

  handleError(error) {
    console.error('Usage polling error:', error.message);

    // Apply exponential backoff for rate limits
    if (error.message.includes('Rate limited')) {
      this.backoffTime = Math.min(this.backoffTime * 2 || 60000, this.maxBackoff);
      setTimeout(() => this.poll(), this.backoffTime);
    }

    // Emit error state
    this.emit('update', {
      used: this.lastTokenUsage || 0,
      limit: 0,
      pct: 0,
      reset_at: null,
      error: error.message,
      cached: true
    });
  }
}

module.exports = UsagePoller;