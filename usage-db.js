/**
 * Usage History Database
 *
 * JSON-backed persistent store that tracks per-project Claude usage over time.
 * Each entry records a usage delta (percentage points attributed to a project)
 * along with the active time for that measurement window.
 *
 * Token conversion: Each entry stores the subscription tier active at recording
 * time. When computing rankings, percentage deltas are converted to token
 * counts using the tier's 5-hour token budget. This means historical usage
 * retains the correct token value even if the user later switches plans.
 *
 * Provides ranking queries by period (today, 7 days, 30 days, all time).
 * Automatically compacts entries older than 30 days into daily summaries.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const log = require('./logger');

const DB_FILE = path.join(os.homedir(), '.alldaypoke', 'usage-history.json');
const COMPACT_AFTER_DAYS = 30;

/**
 * Approximate total token budget per 5-hour window for each subscription tier.
 * Includes both input and output tokens consumed in a window.
 *
 * These values match the social ranking display so local and server-side
 * rankings are consistent. The multiplier between tiers matches Anthropic's
 * public "5x" and "20x" marketing.
 */
const TIER_TOKEN_LIMITS = {
  pro:       5_000_000,  //  ~5M tokens per 5-hour window (Claude Pro)
  max_100:  45_000_000,  // ~45M tokens per 5-hour window (Claude Max $100)
  max_200:  90_000_000,  // ~90M tokens per 5-hour window (Claude Max $200)
};

// Fallback tier when none is recorded AND no current tier is known
const FALLBACK_TIER = 'pro';

class UsageDB {
  constructor() {
    this.data = this.load();
    // The current subscription tier — set by main.js whenever usage data arrives.
    // Used as the default for legacy entries that don't have a tier field,
    // since users who never switched plans should see correct token counts.
    this.currentTier = this._detectTierFromCache();
  }

  /**
   * Try to read the user's current tier from the cached real-usage.json.
   * This covers app startup before the first live usage poll arrives.
   */
  _detectTierFromCache() {
    // First try real-usage.json (most recent data from last API poll)
    try {
      const usageFile = path.join(os.homedir(), '.alldaypoke', 'real-usage.json');
      if (fs.existsSync(usageFile)) {
        const cached = JSON.parse(fs.readFileSync(usageFile, 'utf8'));
        if (cached.subscriptionTier) return cached.subscriptionTier;
      }
    } catch { /* ignore */ }

    // Then try config.json (persisted across disconnections)
    try {
      const configFile = path.join(os.homedir(), '.alldaypoke', 'config.json');
      if (fs.existsSync(configFile)) {
        const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        if (cfg.lastKnownTier) return cfg.lastKnownTier;
      }
    } catch { /* ignore */ }

    return FALLBACK_TIER;
  }

  /**
   * Update the current tier (called by main.js when usage data arrives).
   * Also used as the default for legacy entries without a stored tier.
   */
  setCurrentTier(tier) {
    if (tier) this.currentTier = tier;
  }

  /**
   * Return the effective tier for a given entry/summary.
   * If the entry has a stored tier, use it. Otherwise fall back to the
   * current tier (which is correct when the user has never switched plans).
   */
  _effectiveTier(storedTier) {
    return storedTier || this.currentTier || FALLBACK_TIER;
  }

  /**
   * Load database from disk.
   */
  load() {
    try {
      if (fs.existsSync(DB_FILE)) {
        const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        if (raw.version === 1) return raw;
      }
    } catch (err) {
      log.error('UsageDB: failed to load, starting fresh:', err.message);
    }
    return { version: 1, entries: [], dailySummaries: {} };
  }

  /**
   * Persist database to disk.
   */
  save() {
    try {
      const dir = path.dirname(DB_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(DB_FILE, JSON.stringify(this.data, null, 2));
    } catch (err) {
      log.error('UsageDB: failed to save:', err.message);
    }
  }

  /**
   * Save a snapshot of the last polled usage percentage so that on app restart
   * we can compute how much new usage occurred while the app was closed.
   *
   * @param {number} pct      - Current usage percentage (0-100)
   * @param {string} resetAt  - ISO timestamp of the current window's reset time
   */
  saveLastPollSnapshot(pct, resetAt) {
    this.data.lastPollSnapshot = {
      pct: Math.round(pct * 100) / 100,
      resetAt: resetAt || null,
      timestamp: new Date().toISOString(),
    };
    this.save();
  }

  /**
   * Retrieve the last poll snapshot saved before the app was closed / restarted.
   * Returns null if no snapshot exists.
   */
  getLastPollSnapshot() {
    return this.data.lastPollSnapshot || null;
  }

  /**
   * Convert a percentage delta to an estimated token count using the tier's budget.
   *
   * @param {number} deltaPercent - Usage percentage points (e.g. 2.5 means 2.5%)
   * @param {string} tier         - Subscription tier at recording time
   * @returns {number} Estimated tokens consumed
   */
  static percentToTokens(deltaPercent, tier) {
    const limit = TIER_TOKEN_LIMITS[tier] || TIER_TOKEN_LIMITS[FALLBACK_TIER];
    return Math.round((deltaPercent / 100) * limit);
  }

  /**
   * Record a usage entry for a project.
   *
   * @param {string} project       - Project/directory name
   * @param {number} deltaPercent  - Usage percentage points attributed
   * @param {number} activeTimeMs  - Milliseconds the session was active during this window
   * @param {string} [tier]        - Subscription tier at time of usage ('pro', 'max_100', 'max_200')
   */
  recordUsage(project, deltaPercent, activeTimeMs = 0, tier = null) {
    if (!project || deltaPercent <= 0) return;

    const now = new Date();
    const date = this.dateKey(now);
    const safeTier = tier || this.currentTier || FALLBACK_TIER;

    this.data.entries.push({
      project,
      timestamp: now.toISOString(),
      date,
      deltaPercent: Math.round(deltaPercent * 100) / 100,
      activeTimeMs: Math.round(activeTimeMs),
      tier: safeTier,
    });

    this.save();

    // Compact old entries periodically (every 100 writes)
    if (this.data.entries.length % 100 === 0) {
      this.compact();
    }
  }

  /**
   * Get usage ranking for a time period.
   *
   * Returns token counts computed from each entry's stored tier so that plan
   * switches don't retroactively change historical numbers.
   *
   * @param {'today'|'7d'|'30d'|'all'} period
   * @returns {Array<{rank, project, totalTokens, totalDelta, totalTimeMs, sessionCount, lastActive}>}
   */
  getRanking(period = 'all') {
    const cutoff = this.getCutoffDate(period);
    const projectMap = new Map();

    // Aggregate from daily summaries (for compacted data).
    // Compacted summaries store totalTokens directly (computed at compaction time).
    // Legacy summaries without totalTokens fall back to converting totalDelta
    // using the user's current tier (correct when the user never switched plans).
    for (const [date, projects] of Object.entries(this.data.dailySummaries || {})) {
      if (new Date(date) < cutoff) continue;
      for (const [project, summary] of Object.entries(projects)) {
        const existing = projectMap.get(project) || {
          totalTokens: 0, totalDelta: 0, totalTimeMs: 0, sessionCount: 0, lastActive: null,
        };
        existing.totalTokens += summary.totalTokens != null
          ? summary.totalTokens
          : UsageDB.percentToTokens(summary.totalDelta || 0, this._effectiveTier(null));
        existing.totalDelta += summary.totalDelta || 0;
        existing.totalTimeMs += summary.totalTimeMs || 0;
        existing.sessionCount += summary.count || 0;
        if (!existing.lastActive || date > existing.lastActive) {
          existing.lastActive = date;
        }
        projectMap.set(project, existing);
      }
    }

    // Aggregate from recent entries — convert each entry using its own stored tier,
    // falling back to the current tier for legacy entries without one.
    for (const entry of this.data.entries) {
      if (new Date(entry.timestamp) < cutoff) continue;
      const existing = projectMap.get(entry.project) || {
        totalTokens: 0, totalDelta: 0, totalTimeMs: 0, sessionCount: 0, lastActive: null,
      };
      const entryTier = this._effectiveTier(entry.tier);
      existing.totalTokens += UsageDB.percentToTokens(entry.deltaPercent || 0, entryTier);
      existing.totalDelta += entry.deltaPercent || 0;
      existing.totalTimeMs += entry.activeTimeMs || 0;
      existing.sessionCount += 1;
      const entryDate = entry.timestamp;
      if (!existing.lastActive || entryDate > existing.lastActive) {
        existing.lastActive = entryDate;
      }
      projectMap.set(entry.project, existing);
    }

    // Sort by total tokens descending
    const ranking = Array.from(projectMap.entries())
      .map(([project, stats]) => ({
        project,
        totalTokens: stats.totalTokens,
        totalDelta: Math.round(stats.totalDelta * 100) / 100,
        totalTimeMs: stats.totalTimeMs,
        sessionCount: stats.sessionCount,
        lastActive: stats.lastActive,
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens);

    // Add rank numbers
    return ranking.map((item, index) => ({ rank: index + 1, ...item }));
  }

  /**
   * Get total usage across all projects for a period.
   */
  getTotalUsage(period = 'all') {
    const ranking = this.getRanking(period);
    return {
      totalTokens: ranking.reduce((sum, r) => sum + r.totalTokens, 0),
      totalDelta: ranking.reduce((sum, r) => sum + r.totalDelta, 0),
      totalTimeMs: ranking.reduce((sum, r) => sum + r.totalTimeMs, 0),
      projectCount: ranking.length,
    };
  }

  /**
   * Get usage history for a specific project (last N days).
   */
  getProjectHistory(project, days = 30) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const dailyMap = new Map();

    // From summaries
    for (const [date, projects] of Object.entries(this.data.dailySummaries || {})) {
      if (new Date(date) < cutoff) continue;
      if (projects[project]) {
        dailyMap.set(date, {
          date,
          delta: projects[project].totalDelta || 0,
          timeMs: projects[project].totalTimeMs || 0,
          count: projects[project].count || 0,
        });
      }
    }

    // From entries
    for (const entry of this.data.entries) {
      if (new Date(entry.timestamp) < cutoff) continue;
      if (entry.project !== project) continue;
      const date = entry.date;
      const existing = dailyMap.get(date) || { date, delta: 0, timeMs: 0, count: 0 };
      existing.delta += entry.deltaPercent || 0;
      existing.timeMs += entry.activeTimeMs || 0;
      existing.count += 1;
      dailyMap.set(date, existing);
    }

    return Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * Compact entries older than COMPACT_AFTER_DAYS into daily summaries.
   */
  compact() {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - COMPACT_AFTER_DAYS);

    const toCompact = [];
    const toKeep = [];

    for (const entry of this.data.entries) {
      if (new Date(entry.timestamp) < cutoff) {
        toCompact.push(entry);
      } else {
        toKeep.push(entry);
      }
    }

    if (toCompact.length === 0) return;

    // Merge into daily summaries
    if (!this.data.dailySummaries) this.data.dailySummaries = {};

    for (const entry of toCompact) {
      const date = entry.date;
      if (!this.data.dailySummaries[date]) this.data.dailySummaries[date] = {};
      const dayProjects = this.data.dailySummaries[date];

      if (!dayProjects[entry.project]) {
        dayProjects[entry.project] = { totalDelta: 0, totalTokens: 0, totalTimeMs: 0, count: 0 };
      }
      const entryTier = this._effectiveTier(entry.tier);
      dayProjects[entry.project].totalDelta += entry.deltaPercent || 0;
      dayProjects[entry.project].totalTokens += UsageDB.percentToTokens(entry.deltaPercent || 0, entryTier);
      dayProjects[entry.project].totalTimeMs += entry.activeTimeMs || 0;
      dayProjects[entry.project].count += 1;
    }

    this.data.entries = toKeep;
    log(`UsageDB: compacted ${toCompact.length} old entries into daily summaries`);
    this.save();
  }

  /**
   * Get entries that haven't been synced to the server yet.
   * Tracks sync state via a `lastSyncTimestamp` marker stored in the DB.
   *
   * @returns {Array} entries newer than the last sync timestamp
   */
  getUnsyncedEntries() {
    const since = this.data.lastSyncTimestamp || null;
    if (!since) return [...this.data.entries]; // first sync — everything
    return this.data.entries.filter(e => e.timestamp > since);
  }

  /**
   * Mark entries up to a given timestamp as synced.
   * Called by SocialSync after a successful push.
   */
  markSynced(timestamp) {
    this.data.lastSyncTimestamp = timestamp;
    this.save();
  }

  // ── Helpers ──

  dateKey(date) {
    // Use local date, not UTC — so "today" matches the user's timezone
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  getCutoffDate(period) {
    const now = new Date();
    switch (period) {
      case 'today': {
        const start = new Date(now);
        start.setHours(0, 0, 0, 0);
        return start;
      }
      case '7d': {
        const d = new Date(now);
        d.setDate(d.getDate() - 7);
        return d;
      }
      case '30d': {
        const d = new Date(now);
        d.setDate(d.getDate() - 30);
        return d;
      }
      case 'all':
      default:
        return new Date(0);
    }
  }

  /**
   * Format milliseconds to human-readable duration.
   */
  static formatTime(ms) {
    if (!ms || ms <= 0) return '0m';
    const hours = Math.floor(ms / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m`;
    return '<1m';
  }

  /**
   * Format a token count to a compact human-readable string.
   * e.g., 1500 → "1500", 12345 → "12K", 1234567 → "1.2M", 1234567890 → "1.2B"
   */
  static formatTokens(tokens) {
    if (!tokens || tokens <= 0) return '0';
    if (tokens >= 1_000_000_000) return `${(tokens / 1_000_000_000).toFixed(1)}B`;
    if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
    if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}K`;
    return String(Math.round(tokens));
  }
}

module.exports = UsageDB;
