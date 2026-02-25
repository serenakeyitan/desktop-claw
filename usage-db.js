/**
 * Usage History Database
 *
 * JSON-backed persistent store that tracks per-project Claude usage over time.
 * Each entry records a usage delta (percentage points attributed to a project)
 * along with the active time for that measurement window.
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

class UsageDB {
  constructor() {
    this.data = this.load();
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
   * Record a usage entry for a project.
   *
   * @param {string} project       - Project/directory name
   * @param {number} deltaPercent  - Usage percentage points attributed
   * @param {number} activeTimeMs  - Milliseconds the session was active during this window
   */
  recordUsage(project, deltaPercent, activeTimeMs = 0) {
    if (!project || deltaPercent <= 0) return;

    const now = new Date();
    const date = this.dateKey(now);

    this.data.entries.push({
      project,
      timestamp: now.toISOString(),
      date,
      deltaPercent: Math.round(deltaPercent * 100) / 100,
      activeTimeMs: Math.round(activeTimeMs),
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
   * @param {'today'|'7d'|'30d'|'all'} period
   * @returns {Array<{rank, project, totalDelta, totalTimeMs, sessionCount, lastActive}>}
   */
  getRanking(period = 'all') {
    const cutoff = this.getCutoffDate(period);
    const projectMap = new Map();

    // Aggregate from daily summaries (for compacted data)
    for (const [date, projects] of Object.entries(this.data.dailySummaries || {})) {
      if (new Date(date) < cutoff) continue;
      for (const [project, summary] of Object.entries(projects)) {
        const existing = projectMap.get(project) || {
          totalDelta: 0, totalTimeMs: 0, sessionCount: 0, lastActive: null,
        };
        existing.totalDelta += summary.totalDelta || 0;
        existing.totalTimeMs += summary.totalTimeMs || 0;
        existing.sessionCount += summary.count || 0;
        if (!existing.lastActive || date > existing.lastActive) {
          existing.lastActive = date;
        }
        projectMap.set(project, existing);
      }
    }

    // Aggregate from recent entries
    for (const entry of this.data.entries) {
      if (new Date(entry.timestamp) < cutoff) continue;
      const existing = projectMap.get(entry.project) || {
        totalDelta: 0, totalTimeMs: 0, sessionCount: 0, lastActive: null,
      };
      existing.totalDelta += entry.deltaPercent || 0;
      existing.totalTimeMs += entry.activeTimeMs || 0;
      existing.sessionCount += 1;
      const entryDate = entry.timestamp;
      if (!existing.lastActive || entryDate > existing.lastActive) {
        existing.lastActive = entryDate;
      }
      projectMap.set(entry.project, existing);
    }

    // Sort by total usage descending
    const ranking = Array.from(projectMap.entries())
      .map(([project, stats]) => ({
        project,
        totalDelta: Math.round(stats.totalDelta * 100) / 100,
        totalTimeMs: stats.totalTimeMs,
        sessionCount: stats.sessionCount,
        lastActive: stats.lastActive,
      }))
      .sort((a, b) => b.totalDelta - a.totalDelta);

    // Add rank numbers
    return ranking.map((item, index) => ({ rank: index + 1, ...item }));
  }

  /**
   * Get total usage across all projects for a period.
   */
  getTotalUsage(period = 'all') {
    const ranking = this.getRanking(period);
    return {
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
        dayProjects[entry.project] = { totalDelta: 0, totalTimeMs: 0, count: 0 };
      }
      dayProjects[entry.project].totalDelta += entry.deltaPercent || 0;
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
}

module.exports = UsageDB;
