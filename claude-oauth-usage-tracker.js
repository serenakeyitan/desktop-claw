/**
 * Claude OAuth Usage Tracker
 *
 * Reads the OAuth token from the macOS Keychain (where Claude Code stores it),
 * refreshes it if expired, and queries the /api/oauth/usage endpoint to get
 * real subscription usage data (5-hour, 7-day windows, etc.).
 */

const { execSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const EventEmitter = require('events');

// Claude Code OAuth config (production)
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const BETA_HEADER = 'oauth-2025-04-20';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

class ClaudeOAuthUsageTracker extends EventEmitter {
  constructor(options = {}) {
    super();
    this.pollIntervalMs = (options.pollIntervalMinutes || 1) * 60 * 1000;
    this.pollTimer = null;
    this.cachedToken = null;
    this.cachedTokenExpiresAt = 0;
    this.lastUsageData = null;
    this.usageFile = path.join(os.homedir(), '.alldaypoke', 'real-usage.json');
  }

  /**
   * Read the OAuth credentials from the macOS Keychain.
   * Claude Code stores them under service "Claude Code-credentials".
   */
  readKeychainCredentials() {
    try {
      const user = os.userInfo().username;
      const raw = execSync(
        `security find-generic-password -a "${user}" -w -s "${KEYCHAIN_SERVICE}"`,
        { encoding: 'utf8', timeout: 5000 }
      ).trim();
      const creds = JSON.parse(raw);
      if (creds.claudeAiOauth) {
        return creds.claudeAiOauth;
      }
      return null;
    } catch (err) {
      console.error('Failed to read Claude keychain credentials:', err.message);
      return null;
    }
  }

  /**
   * Refresh the OAuth access token using the refresh token.
   */
  async refreshToken(refreshToken) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      });

      const url = new URL(TOKEN_URL);
      const options = {
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'claude-code/2.0.29',
          'Content-Length': Buffer.byteLength(body),
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const parsed = JSON.parse(data);
              resolve(parsed);
            } catch (e) {
              reject(new Error(`Failed to parse token response: ${e.message}`));
            }
          } else {
            reject(new Error(`Token refresh failed: HTTP ${res.statusCode} - ${data}`));
          }
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  /**
   * Get a valid access token, refreshing if necessary.
   */
  async getAccessToken() {
    // Return cached token if still valid (with 60s buffer)
    if (this.cachedToken && Date.now() < this.cachedTokenExpiresAt - 60000) {
      return this.cachedToken;
    }

    const creds = this.readKeychainCredentials();
    if (!creds) {
      throw new Error('No Claude OAuth credentials found in keychain');
    }

    // Check if the stored token is still valid
    if (creds.accessToken && creds.expiresAt && Date.now() < creds.expiresAt - 60000) {
      this.cachedToken = creds.accessToken;
      this.cachedTokenExpiresAt = creds.expiresAt;
      return this.cachedToken;
    }

    // Need to refresh
    if (!creds.refreshToken) {
      throw new Error('No refresh token available');
    }

    console.log('Refreshing Claude OAuth token...');
    const tokenData = await this.refreshToken(creds.refreshToken);
    this.cachedToken = tokenData.access_token;
    this.cachedTokenExpiresAt = Date.now() + (tokenData.expires_in * 1000);
    console.log(`Token refreshed, valid for ${tokenData.expires_in}s`);

    return this.cachedToken;
  }

  /**
   * Fetch usage data from the /api/oauth/usage endpoint.
   * Returns the raw API response containing five_hour, seven_day, etc.
   */
  async fetchUsage() {
    const token = await this.getAccessToken();

    return new Promise((resolve, reject) => {
      const url = new URL(USAGE_URL);
      const options = {
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'claude-code/2.0.29',
          'anthropic-beta': BETA_HEADER,
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error(`Failed to parse usage response: ${e.message}`));
            }
          } else if (res.statusCode === 401) {
            // Token might be stale - clear cache and retry on next poll
            this.cachedToken = null;
            this.cachedTokenExpiresAt = 0;
            reject(new Error(`Usage API returned 401 - token may be expired`));
          } else {
            reject(new Error(`Usage API failed: HTTP ${res.statusCode} - ${data}`));
          }
        });
      });

      req.on('error', reject);
      req.end();
    });
  }

  /**
   * Convert the raw API response into the normalized format the app expects.
   */
  /**
   * Detect the subscription tier from keychain credentials.
   * Returns a normalized string: 'pro', 'max_100', or 'max_200'.
   */
  getSubscriptionTier() {
    const creds = this.readKeychainCredentials();
    const raw = (creds?.subscriptionType || '').toLowerCase();
    if (raw.includes('200') || raw.includes('max_200')) return 'max_200';
    if (raw.includes('max') || raw.includes('100')) return 'max_100';
    if (raw.includes('pro')) return 'pro';
    // Default: if we got this far via OAuth, assume at least pro
    return 'pro';
  }

  normalizeUsageData(apiData) {
    const fiveHour = apiData.five_hour;
    const sevenDay = apiData.seven_day;
    const sevenDayOpus = apiData.seven_day_opus;
    const sevenDaySonnet = apiData.seven_day_sonnet;

    // Use five_hour as the primary usage indicator (most relevant for active usage)
    const primaryUtilization = fiveHour?.utilization ?? 0;
    const primaryResetAt = fiveHour?.resets_at ?? null;

    // Read actual subscription tier from keychain
    const tier = this.getSubscriptionTier();
    const tierLabels = { pro: 'Claude Pro', max_100: 'Claude Max', max_200: 'Claude Max ($200)' };

    return {
      // Primary usage (5-hour window)
      percentage: Math.round(primaryUtilization),
      pct: Math.round(primaryUtilization),
      used: Math.round(primaryUtilization),
      limit: 100,
      resetAt: primaryResetAt,
      reset_at: primaryResetAt,
      subscription: tierLabels[tier] || 'Claude Pro',
      subscriptionTier: tier,
      type: '5-hour',
      realData: true,
      source: 'claude-oauth-api',
      timestamp: new Date().toISOString(),

      // Detailed breakdown
      details: {
        five_hour: fiveHour ? {
          utilization: fiveHour.utilization,
          resets_at: fiveHour.resets_at,
        } : null,
        seven_day: sevenDay ? {
          utilization: sevenDay.utilization,
          resets_at: sevenDay.resets_at,
        } : null,
        seven_day_opus: sevenDayOpus ? {
          utilization: sevenDayOpus.utilization,
          resets_at: sevenDayOpus.resets_at,
        } : null,
        seven_day_sonnet: sevenDaySonnet ? {
          utilization: sevenDaySonnet.utilization,
          resets_at: sevenDaySonnet.resets_at,
        } : null,
        extra_usage: apiData.extra_usage || null,
      },
    };
  }

  /**
   * Save usage data to disk for persistence.
   */
  saveUsage(normalizedData) {
    try {
      const dir = path.dirname(this.usageFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.usageFile, JSON.stringify(normalizedData, null, 2));
    } catch (err) {
      console.error('Failed to save usage data:', err.message);
    }
  }

  /**
   * Check usage once: fetch, normalize, save, and emit.
   */
  async checkUsage() {
    try {
      const rawData = await this.fetchUsage();
      const normalized = this.normalizeUsageData(rawData);
      this.lastUsageData = normalized;
      this.saveUsage(normalized);

      console.log(
        `Claude usage updated: 5h=${normalized.details.five_hour?.utilization ?? 'N/A'}%` +
        ` | 7d=${normalized.details.seven_day?.utilization ?? 'N/A'}%` +
        ` | resets=${normalized.reset_at ?? 'unknown'}`
      );

      this.emit('usage-updated', normalized);
      return normalized;
    } catch (err) {
      console.error('Failed to check Claude usage:', err.message);
      this.emit('error', err);
      return null;
    }
  }

  /**
   * Start polling for usage data.
   */
  async start() {
    console.log('Starting Claude OAuth usage tracker...');

    // Verify we can read credentials
    const creds = this.readKeychainCredentials();
    if (!creds) {
      console.error('No Claude Code OAuth credentials found. Is Claude Code logged in?');
      return false;
    }

    console.log(`Found Claude ${creds.subscriptionType || 'Pro'} subscription credentials`);

    // Do an initial check
    await this.checkUsage();

    // Start polling
    this.pollTimer = setInterval(() => {
      this.checkUsage();
    }, this.pollIntervalMs);

    console.log(`Polling usage every ${this.pollIntervalMs / 1000}s`);
    return true;
  }

  /**
   * Stop polling.
   */
  stop() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.cachedToken = null;
    this.cachedTokenExpiresAt = 0;
  }

  /**
   * Get the last known usage data.
   */
  getUsageData() {
    return this.lastUsageData;
  }
}

module.exports = ClaudeOAuthUsageTracker;
