/**
 * Claude OAuth Usage Tracker
 *
 * Reads the OAuth token from the macOS Keychain (where Claude Code stores it),
 * refreshes it if expired, and queries the /api/oauth/usage endpoint to get
 * real subscription usage data (5-hour, 7-day windows, etc.).
 */

const { execFileSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const EventEmitter = require('events');
const log = require('./logger');

// Claude Code OAuth config (production)
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const BETA_HEADER = 'oauth-2025-04-20';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

// Number of consecutive auth failures before emitting 'auth-needed'.
// With ~60s polling, 3 failures ≈ 3 minutes of sustained auth problems.
const AUTH_FAIL_THRESHOLD = 3;

class ClaudeOAuthUsageTracker extends EventEmitter {
  constructor(options = {}) {
    super();
    this.pollIntervalMs = (options.pollIntervalMinutes || 2) * 60 * 1000;
    this.pollTimer = null;
    this.cachedToken = null;
    this.cachedTokenExpiresAt = 0;
    this.lastUsageData = null;
    this.usageFile = path.join(os.homedir(), '.alldaypoke', 'real-usage.json');
    // Auth failure tracking for login-retry detection
    this.consecutiveAuthFailures = 0;
    this.authNeededEmitted = false; // only emit once until credentials return
  }

  /**
   * Read the OAuth credentials from the macOS Keychain.
   * Claude Code stores them under service "Claude Code-credentials".
   */
  readKeychainCredentials() {
    try {
      const user = os.userInfo().username;
      const raw = execFileSync(
        'security',
        ['find-generic-password', '-a', user, '-w', '-s', KEYCHAIN_SERVICE],
        { encoding: 'utf8', timeout: 5000 }
      ).trim();
      const creds = JSON.parse(raw);
      if (creds.claudeAiOauth) {
        return creds.claudeAiOauth;
      }
      return null;
    } catch (err) {
      log.error('Failed to read Claude keychain credentials:', err.message);
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

    log('Refreshing Claude OAuth token...');
    const tokenData = await this.refreshToken(creds.refreshToken);
    this.cachedToken = tokenData.access_token;
    this.cachedTokenExpiresAt = Date.now() + (tokenData.expires_in * 1000);
    log(`Token refreshed, valid for ${tokenData.expires_in}s`);

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
            // Token is stale — clear cache so next getAccessToken() re-reads keychain
            this.cachedToken = null;
            this.cachedTokenExpiresAt = 0;
            reject(new Error(`Usage API returned 401 - token may be expired`));
          } else if (res.statusCode === 403) {
            // Credentials revoked or subscription changed
            this.cachedToken = null;
            this.cachedTokenExpiresAt = 0;
            reject(new Error(`Usage API returned 403 - credentials may be revoked`));
          } else if (res.statusCode === 429) {
            // Usage API rate limit — resolve with a sentinel so checkUsage()
            // can re-use the last known good data instead of failing silently.
            const retryAfter = res.headers['retry-after'];
            resolve({ _rateLimited: true, retryAfterSec: retryAfter ? parseInt(retryAfter, 10) : 60 });
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

    // Keychain didn't have a recognisable tier — fall back to the last
    // successfully detected tier persisted in config, so that a temporary
    // disconnection doesn't reset a Max user's display to "Pro".
    try {
      const cfgPath = path.join(os.homedir(), '.alldaypoke', 'config.json');
      if (fs.existsSync(cfgPath)) {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        if (cfg.lastKnownTier) return cfg.lastKnownTier;
      }
    } catch { /* ignore */ }

    // Ultimate fallback when nothing is persisted (first launch)
    return 'pro';
  }

  normalizeUsageData(apiData) {
    const fiveHour = apiData.five_hour;
    const sevenDay = apiData.seven_day;
    const sevenDayOpus = apiData.seven_day_opus;
    const sevenDaySonnet = apiData.seven_day_sonnet;

    // Pick the window with the highest utilization as the primary display.
    // The 5-hour window is preferred, but if it reads 0 while 7-day has
    // real usage the user would see a misleading 0%.  In that case fall
    // back to the 7-day window so something meaningful is always shown.
    const fiveHourUtil  = fiveHour?.utilization  ?? 0;
    const sevenDayUtil  = sevenDay?.utilization  ?? 0;

    let primaryUtilization, primaryResetAt, primaryType;
    if (fiveHourUtil > 0 || sevenDayUtil === 0) {
      // Normal case — 5-hour has usage, or both are 0
      primaryUtilization = fiveHourUtil;
      primaryResetAt = fiveHour?.resets_at ?? null;
      primaryType = '5-hour';
    } else {
      // 5-hour is 0 but 7-day has usage — show 7-day instead
      primaryUtilization = sevenDayUtil;
      primaryResetAt = sevenDay?.resets_at ?? null;
      primaryType = '7-day';
    }

    // Read actual subscription tier from keychain
    const tier = this.getSubscriptionTier();
    const tierLabels = { pro: 'Claude Pro', max_100: 'Claude Max', max_200: 'Claude Max ($200)' };

    // Never round down to 0% when there IS usage — ceiling at 0.1% minimum.
    // On large-budget tiers (Max: 45M tokens), normal usage can be < 0.1%
    // which Math.round() would silently kill.
    let roundedPct;
    if (primaryUtilization <= 0) {
      roundedPct = 0;
    } else if (primaryUtilization < 1) {
      // Show one decimal, but floor to at least 0.1 so it's never hidden
      roundedPct = Math.max(0.1, Math.round(primaryUtilization * 10) / 10);
    } else {
      roundedPct = Math.round(primaryUtilization);
    }

    return {
      // Primary usage — whichever window is most informative
      percentage: roundedPct,
      pct: roundedPct,
      used: roundedPct,
      limit: 100,
      resetAt: primaryResetAt,
      reset_at: primaryResetAt,
      subscription: tierLabels[tier] || 'Claude Pro',
      subscriptionTier: tier,
      type: primaryType,
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
   * Load cached usage data from disk (fallback for 429s on first poll).
   */
  _loadCachedUsage() {
    try {
      if (fs.existsSync(this.usageFile)) {
        const data = JSON.parse(fs.readFileSync(this.usageFile, 'utf8'));
        if (data && data.pct !== undefined) {
          log('Loaded cached usage from disk');
          return data;
        }
      }
    } catch (err) {
      log.error('Failed to load cached usage:', err.message);
    }
    return null;
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
      log.error('Failed to save usage data:', err.message);
    }
  }

  /**
   * Check usage once: fetch, normalize, save, and emit.
   * Tracks consecutive auth failures and emits 'auth-needed' when Claude Code
   * credentials are missing or invalid for AUTH_FAIL_THRESHOLD consecutive polls.
   */
  async checkUsage() {
    try {
      const rawData = await this.fetchUsage();

      // Handle usage API rate limit — re-emit last known data with updated timestamp
      if (rawData && rawData._rateLimited) {
        log(`Usage API rate-limited (retry after ${rawData.retryAfterSec}s), re-using last data`);
        // If we have no in-memory data yet, try loading from disk
        if (!this.lastUsageData) {
          this.lastUsageData = this._loadCachedUsage();
        }
        if (this.lastUsageData) {
          this.lastUsageData.timestamp = new Date().toISOString();
          this.emit('usage-updated', this.lastUsageData);
        }
        return this.lastUsageData;
      }

      const normalized = this.normalizeUsageData(rawData);
      this.lastUsageData = normalized;
      this.saveUsage(normalized);

      // Success — reset auth failure tracking
      if (this.consecutiveAuthFailures > 0) {
        log(`Auth recovered after ${this.consecutiveAuthFailures} failures`);
      }
      this.consecutiveAuthFailures = 0;
      if (this.authNeededEmitted) {
        this.authNeededEmitted = false;
        this.emit('auth-recovered');
      }

      log(
        `Claude usage updated: 5h=${normalized.details.five_hour?.utilization ?? 'N/A'}%` +
        ` | 7d=${normalized.details.seven_day?.utilization ?? 'N/A'}%` +
        ` | showing=${normalized.type} (${normalized.pct}%)` +
        ` | resets=${normalized.reset_at ?? 'unknown'}`
      );

      this.emit('usage-updated', normalized);
      return normalized;
    } catch (err) {
      log.error('Failed to check Claude usage:', err.message);

      // On a 401/403, immediately retry once with a fresh token from keychain.
      // This handles the common case where the cached token expired but the
      // keychain still has a valid refresh token (e.g., user re-logged into
      // Claude Code in the background).
      const is401or403 = err.message.includes('401') || err.message.includes('403');
      if (is401or403 && !this._retrying) {
        this._retrying = true;
        log('Got 401/403 — retrying once with fresh credentials...');
        try {
          const retryResult = await this.fetchUsage();
          const normalized = this.normalizeUsageData(retryResult);
          this.lastUsageData = normalized;
          this.saveUsage(normalized);

          // Retry succeeded — reset failure tracking
          if (this.consecutiveAuthFailures > 0) {
            log(`Auth recovered on retry after ${this.consecutiveAuthFailures} failures`);
          }
          this.consecutiveAuthFailures = 0;
          if (this.authNeededEmitted) {
            this.authNeededEmitted = false;
            this.emit('auth-recovered');
          }

          this.emit('usage-updated', normalized);
          return normalized;
        } catch (retryErr) {
          log.error('Retry also failed:', retryErr.message);
          // Fall through to normal failure handling below
        } finally {
          this._retrying = false;
        }
      }

      this.emit('error', err);

      // Track auth-related failures (missing credentials, 401, refresh failure)
      const isAuthError = err.message.includes('credentials')
        || err.message.includes('401')
        || err.message.includes('403')
        || err.message.includes('refresh token')
        || err.message.includes('Token refresh failed');

      if (isAuthError) {
        this.consecutiveAuthFailures++;
        log(`Auth failure ${this.consecutiveAuthFailures}/${AUTH_FAIL_THRESHOLD}: ${err.message}`);

        if (this.consecutiveAuthFailures >= AUTH_FAIL_THRESHOLD && !this.authNeededEmitted) {
          this.authNeededEmitted = true;
          log('Auth needed — emitting auth-needed event');
          this.emit('auth-needed', {
            reason: err.message,
            failures: this.consecutiveAuthFailures,
          });
        }
      }

      return null;
    }
  }

  /**
   * Start polling for usage data.
   */
  async start() {
    log('Starting Claude OAuth usage tracker...');

    // Load cached data from disk so we have something to show immediately
    if (!this.lastUsageData) {
      this.lastUsageData = this._loadCachedUsage();
      if (this.lastUsageData) {
        log('Pre-loaded cached usage data from disk');
      }
    }

    // Verify we can read credentials
    const creds = this.readKeychainCredentials();
    if (!creds) {
      log.error('No Claude Code OAuth credentials found. Is Claude Code logged in?');
      // Still emit cached data if available so tooltip isn't empty
      if (this.lastUsageData) {
        this.emit('usage-updated', this.lastUsageData);
      }
      return false;
    }

    log(`Found Claude ${creds.subscriptionType || 'Pro'} subscription credentials`);

    // Do an initial check
    await this.checkUsage();

    // Start polling
    this.pollTimer = setInterval(() => {
      this.checkUsage();
    }, this.pollIntervalMs);

    log(`Polling usage every ${this.pollIntervalMs / 1000}s`);
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
