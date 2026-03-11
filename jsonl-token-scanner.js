/**
 * JSONL Token Scanner
 *
 * Scans Claude Code conversation JSONL files in ~/.claude/projects/ to extract
 * real token usage for ALL users — works with both OAuth and API key auth.
 *
 * Claude Code writes JSONL conversation logs that include `message.usage` on
 * every assistant response, containing exact input/output token counts.  This
 * scanner watches for new data, sums tokens per project, and emits periodic
 * usage events that main.js records into usage-db for social ranking.
 *
 * Architecture:
 *   1. On start, scan all project dirs for the most-recently-modified JSONL.
 *   2. Record a "cursor" (file path + byte offset) so we only read new data.
 *   3. Every pollIntervalMs, re-scan for new/modified files and parse new lines.
 *   4. Emit 'tokens' events with { project, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const EventEmitter = require('events');
const log = require('./logger');

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

class JsonlTokenScanner extends EventEmitter {
  constructor(options = {}) {
    super();
    this.pollIntervalMs = (options.pollIntervalSeconds || 30) * 1000;
    this.pollTimer = null;
    // Map of filePath -> { offset: number } — tracks how far we've read each file
    this.cursors = new Map();
    // Persist cursor state to disk so restarts don't re-count old tokens
    this.stateFile = path.join(os.homedir(), '.alldaypoke', 'jsonl-scanner-state.json');
    this._loadState();
  }

  /**
   * Load persisted cursor state from disk.
   */
  _loadState() {
    try {
      if (fs.existsSync(this.stateFile)) {
        const data = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
        if (data.cursors) {
          for (const [filePath, cursor] of Object.entries(data.cursors)) {
            this.cursors.set(filePath, cursor);
          }
        }
      }
    } catch {
      // Start fresh if state is corrupted
    }
  }

  /**
   * Persist cursor state to disk.
   */
  _saveState() {
    try {
      const dir = path.dirname(this.stateFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const data = { cursors: {} };
      for (const [filePath, cursor] of this.cursors) {
        data.cursors[filePath] = cursor;
      }
      fs.writeFileSync(this.stateFile, JSON.stringify(data));
    } catch (err) {
      log.error('JSONL scanner: failed to save state:', err.message);
    }
  }

  /**
   * Extract project name from a Claude projects directory path.
   * e.g., "-Users-keyitan-desktop-bot" -> "desktop-bot"
   */
  _projectNameFromDir(dirName) {
    // Claude encodes paths by replacing / with -
    // e.g., "-Users-keyitan-my-project" -> last segment is the project
    const parts = dirName.split('-').filter(Boolean);
    // The project name is everything after the user's home path segments.
    // Typically: Users, <username>, <project...>
    // Find the segment after the username
    const homeSegments = os.homedir().split(path.sep).filter(Boolean);
    let projectParts = parts;
    // Try to strip the home dir prefix
    let matchLen = 0;
    for (let i = 0; i < homeSegments.length && i < parts.length; i++) {
      if (parts[i] === homeSegments[i]) matchLen++;
      else break;
    }
    if (matchLen >= 2) {
      projectParts = parts.slice(matchLen);
    }
    return projectParts.join('-') || '(home)';
  }

  /**
   * Find all recently-modified JSONL files across all project directories.
   * Only considers files modified in the last 6 hours (one usage window).
   */
  _findActiveJsonlFiles() {
    const files = [];
    const now = Date.now();
    const maxAge = 6 * 60 * 60 * 1000; // 6 hours

    try {
      if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) return files;

      const projectDirs = fs.readdirSync(CLAUDE_PROJECTS_DIR);
      for (const dirName of projectDirs) {
        const dirPath = path.join(CLAUDE_PROJECTS_DIR, dirName);
        try {
          const stat = fs.statSync(dirPath);
          if (!stat.isDirectory()) continue;
        } catch { continue; }

        const projectName = this._projectNameFromDir(dirName);

        try {
          const jsonlFiles = fs.readdirSync(dirPath)
            .filter(f => f.endsWith('.jsonl'));

          for (const file of jsonlFiles) {
            const filePath = path.join(dirPath, file);
            try {
              const fstat = fs.statSync(filePath);
              if (now - fstat.mtimeMs < maxAge) {
                files.push({ filePath, projectName, size: fstat.size, mtime: fstat.mtimeMs });
              }
            } catch { /* skip */ }
          }
        } catch { /* skip unreadable dirs */ }
      }
    } catch (err) {
      log.error('JSONL scanner: failed to scan projects dir:', err.message);
    }

    return files;
  }

  /**
   * Read new lines from a JSONL file starting from the saved cursor offset.
   * Returns array of parsed JSON objects that have message.usage.
   */
  _readNewTokenEntries(filePath, fileSize) {
    const cursor = this.cursors.get(filePath) || { offset: 0 };

    // If file shrunk (truncated/replaced), reset cursor
    if (fileSize < cursor.offset) {
      cursor.offset = 0;
    }

    if (cursor.offset >= fileSize) {
      return []; // Nothing new
    }

    const entries = [];
    try {
      const fd = fs.openSync(filePath, 'r');
      const bytesToRead = fileSize - cursor.offset;
      const buf = Buffer.alloc(bytesToRead);
      fs.readSync(fd, buf, 0, bytesToRead, cursor.offset);
      fs.closeSync(fd);

      const text = buf.toString('utf8');
      const lines = text.split('\n');

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line.trim());
          // Only care about assistant messages with usage data
          if (data.type === 'assistant' && data.message && data.message.usage) {
            entries.push(data.message.usage);
          }
        } catch {
          // Skip malformed lines
        }
      }

      // Update cursor to end of file
      cursor.offset = fileSize;
      this.cursors.set(filePath, cursor);
    } catch (err) {
      log.error(`JSONL scanner: error reading ${path.basename(filePath)}:`, err.message);
    }

    return entries;
  }

  /**
   * Poll once: scan for new JSONL data and emit token usage events.
   */
  poll() {
    const activeFiles = this._findActiveJsonlFiles();
    let totalNewTokens = 0;

    // Group by project
    const projectTokens = new Map();

    for (const { filePath, projectName, size } of activeFiles) {
      const usageEntries = this._readNewTokenEntries(filePath, size);
      if (usageEntries.length === 0) continue;

      let projectData = projectTokens.get(projectName);
      if (!projectData) {
        projectData = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
        projectTokens.set(projectName, projectData);
      }

      for (const usage of usageEntries) {
        projectData.inputTokens += (usage.input_tokens || 0);
        projectData.outputTokens += (usage.output_tokens || 0);
        projectData.cacheReadTokens += (usage.cache_read_input_tokens || 0);
        projectData.cacheWriteTokens += (usage.cache_creation_input_tokens || 0);
      }
    }

    // Emit per-project token events
    for (const [project, tokens] of projectTokens) {
      const total = tokens.inputTokens + tokens.outputTokens
                  + tokens.cacheReadTokens + tokens.cacheWriteTokens;
      if (total > 0) {
        totalNewTokens += total;
        this.emit('tokens', {
          project,
          inputTokens: tokens.inputTokens,
          outputTokens: tokens.outputTokens,
          cacheReadTokens: tokens.cacheReadTokens,
          cacheWriteTokens: tokens.cacheWriteTokens,
          totalTokens: total,
        });
      }
    }

    if (totalNewTokens > 0) {
      log(`JSONL scanner: ${totalNewTokens.toLocaleString()} new tokens across ${projectTokens.size} project(s)`);
    }

    // Save state periodically
    this._saveState();
  }

  /**
   * Start polling.
   */
  start() {
    log('JSONL token scanner started');
    // Do an initial scan
    this.poll();
    // Then poll periodically
    this.pollTimer = setInterval(() => this.poll(), this.pollIntervalMs);
  }

  /**
   * Stop polling.
   */
  stop() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this._saveState();
  }
}

module.exports = JsonlTokenScanner;
