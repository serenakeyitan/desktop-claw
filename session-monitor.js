/**
 * Claude Code Session Monitor
 *
 * Detects active Claude Code sessions using a hybrid approach:
 *
 * 1. PRIMARY: Scans ~/.claude/debug/*.txt for recently-modified files.
 *    Each debug file corresponds to one Claude Code session and contains
 *    the project path in its first few lines. A file modified within the
 *    last FRESHNESS_THRESHOLD_SEC seconds is considered active.
 *
 * 2. SUPPLEMENT: Uses `ps` to get CPU time for each detected session,
 *    enabling busy/idle tracking via cumulative CPU time deltas.
 *
 * 3. FALLBACK: If no debug files are found, falls back to pure process
 *    scanning (legacy approach).
 *
 * 4. SSH DETECTION: Scans for outgoing SSH connections to detect Claude
 *    Code sessions running on remote machines (same account, shared API key).
 *    These appear as "remote" sessions with the SSH host as the project name.
 *
 * The debug-file approach is more accurate than process scanning because:
 * - No process name ambiguity (claude vs node vs npx)
 * - Works regardless of how Claude was launched
 * - Reliably extracts project info from file contents
 * - Active sessions = recently modified debug files
 */

const { execSync } = require('child_process');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const os = require('os');

// If a process consumes less than this many CPU-seconds per poll interval,
// it is considered idle (waiting at the prompt). A truly idle Claude process
// uses ~0s of CPU. An active one uses 1-4s per 5-second poll.
const CPU_DELTA_IDLE_THRESHOLD = 0.3; // seconds of CPU per poll

// Number of consecutive idle polls before we declare the session idle.
// With 5s polling this means 30s of sustained idle before "task finished".
const IDLE_CONFIRM_POLLS = 6;

// Minimum busy duration (ms) before a task-finished notification fires.
const MIN_BUSY_DURATION_MS = 30 * 1000; // 30 seconds

// Debug files modified more recently than this are considered active sessions.
// Set to 2 minutes to be generous — active sessions write debug output frequently.
const FRESHNESS_THRESHOLD_SEC = 120;

// Claude debug directory
const CLAUDE_DEBUG_DIR = path.join(os.homedir(), '.claude', 'debug');

class SessionMonitor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.pollIntervalMs = (options.pollIntervalSeconds || 5) * 1000;
    this.pollTimer = null;
    // Map of sessionId (debug file UUID or PID) -> session info
    this.sessions = new Map();
  }

  /**
   * Parse cputime string (MM:SS.xx or HH:MM:SS) to total seconds.
   */
  parseCpuTime(timeStr) {
    if (!timeStr) return 0;
    const parts = timeStr.split(':');
    if (parts.length === 2) {
      // MM:SS.xx
      return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
    } else if (parts.length === 3) {
      // HH:MM:SS
      return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
    }
    return parseFloat(timeStr) || 0;
  }

  /**
   * PRIMARY DETECTION: Scan ~/.claude/debug/ for active sessions.
   *
   * Returns an array of { sessionId, project, cwd, mtime } objects
   * for each debug file modified within FRESHNESS_THRESHOLD_SEC.
   */
  scanDebugFiles() {
    const sessions = [];
    const now = Date.now();
    const thresholdMs = FRESHNESS_THRESHOLD_SEC * 1000;

    try {
      if (!fs.existsSync(CLAUDE_DEBUG_DIR)) return sessions;

      const files = fs.readdirSync(CLAUDE_DEBUG_DIR)
        .filter(f => f.endsWith('.txt'));

      for (const file of files) {
        const filePath = path.join(CLAUDE_DEBUG_DIR, file);
        try {
          const stat = fs.statSync(filePath);
          const ageMs = now - stat.mtimeMs;

          if (ageMs > thresholdMs) continue; // stale file, skip

          // Extract session UUID from filename (e.g., "15a82081-1bfb-4296-bc94-48af7f932284.txt")
          const sessionId = file.replace('.txt', '');

          // Extract project path from file content
          const projectInfo = this._extractProjectFromDebugFile(filePath);

          sessions.push({
            sessionId,
            cwd: projectInfo.cwd,
            project: projectInfo.project,
            mtime: stat.mtimeMs,
            ageMs,
            filePath,
            fileSize: stat.size,
          });
        } catch {
          // Skip files we can't stat/read
        }
      }
    } catch {
      // Debug directory doesn't exist or isn't readable
    }

    return sessions;
  }

  /**
   * Extract the project path from a Claude Code debug file.
   *
   * Tries two patterns from the first 5 lines:
   * 1. settings.local.json path: ".../<project>/.claude/settings.local.json"
   * 2. skills project path: "project=/<path>/.claude/skills"
   */
  _extractProjectFromDebugFile(filePath) {
    try {
      // Read just the first 1KB — project info is always in the first few lines
      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(1024);
      const bytesRead = fs.readSync(fd, buf, 0, 1024, 0);
      fs.closeSync(fd);

      const header = buf.toString('utf8', 0, bytesRead);

      // Pattern 1: settings.local.json path
      // e.g., "/Users/keyitan/desktop_bot/.claude/settings.local.json"
      const localSettingsMatch = header.match(/\/([^\s,]+)\/\.claude\/settings\.local\.json/);
      if (localSettingsMatch) {
        const cwd = '/' + localSettingsMatch[1];
        return { cwd, project: path.basename(cwd) };
      }

      // Pattern 2: skills project path
      // e.g., "project=/Users/keyitan/peer-kael-claw/.claude/skills"
      const skillsMatch = header.match(/project=([^\s,]+)\/\.claude\/skills/);
      if (skillsMatch) {
        const cwd = skillsMatch[1];
        return { cwd, project: path.basename(cwd) };
      }
    } catch {
      // Can't read file
    }

    return { cwd: null, project: null };
  }

  /**
   * Scan for running Claude Code processes.
   * Returns array of { pid, tty, elapsed, elapsedMs, cpuTimeSec, cwd, project }.
   *
   * Uses two strategies to catch all Claude processes regardless of how
   * the binary appears in ps output (claude vs node).
   */
  scanProcesses() {
    const seenPids = new Set();
    const processes = [];

    const commands = [
      // Strategy 1: Match processes with comm == "claude"
      `ps -eo pid,tty,etime,cputime,comm 2>/dev/null | grep -w "claude$" | grep -v grep`,
      // Strategy 2: Match node processes running claude-code CLI
      `ps -eo pid,tty,etime,cputime,args 2>/dev/null | grep -E "claude-code|/bin/claude" | grep -v grep`,
    ];

    for (const cmd of commands) {
      try {
        const raw = execSync(cmd, { encoding: 'utf8', timeout: 5000 }).trim();
        if (!raw) continue;

        for (const line of raw.split('\n')) {
          const parts = line.trim().split(/\s+/);
          if (parts.length < 5) continue;
          const pid = parseInt(parts[0], 10);
          if (isNaN(pid) || seenPids.has(pid)) continue;

          // Exclude helper processes
          const rest = parts.slice(4).join(' ');
          if (rest.includes('Electron') || rest.includes('expect') ||
              rest.includes('shell-snapshot') || rest.includes('get-claude-usage') ||
              rest.includes('/bin/zsh')) continue;

          seenPids.add(pid);

          // Get process cwd via lsof
          let cwd = null;
          try {
            const lsofOut = execSync(
              `lsof -a -d cwd -p ${pid} -Fn 2>/dev/null | grep "^n/"`,
              { encoding: 'utf8', timeout: 3000 }
            ).trim();
            if (lsofOut) {
              cwd = lsofOut.replace(/^n/, '');
            }
          } catch { /* lsof might fail */ }

          processes.push({
            pid,
            tty: parts[1] === '??' ? null : parts[1],
            elapsed: parts[2],
            elapsedMs: this.parseElapsed(parts[2]),
            cpuTimeSec: this.parseCpuTime(parts[3]),
            cwd,
            project: cwd ? path.basename(cwd) : null,
          });
        }
      } catch { /* no matches */ }
    }

    return processes;
  }

  /**
   * SSH DETECTION: Scan for outgoing SSH connections.
   *
   * Detects SSH sessions from this machine to remote hosts where Claude Code
   * may be running with the same API key/account. These appear as "remote"
   * sessions since we can't inspect the remote process directly.
   *
   * Returns array of { id, pid, host, user, elapsed, elapsedMs }.
   */
  scanSSHSessions() {
    const sessions = [];

    try {
      // Find outgoing ssh processes (interactive sessions, not scp/sftp/tunnels)
      const raw = execSync(
        `ps -eo pid,tty,etime,args 2>/dev/null | grep -E "^\\s*[0-9]+\\s+\\S+\\s+\\S+\\s+ssh\\s+" | grep -v grep | grep -v -- "-N" | grep -v -- "-L" | grep -v -- "-R" | grep -v -- "-D"`,
        { encoding: 'utf8', timeout: 5000 }
      ).trim();
      if (!raw) return sessions;

      for (const line of raw.split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 4) continue;

        const pid = parseInt(parts[0], 10);
        if (isNaN(pid)) continue;

        const tty = parts[1] === '??' ? null : parts[1];
        const elapsed = parts[2];
        const elapsedMs = this.parseElapsed(elapsed);

        // Parse the ssh args to extract user@host or just host
        const sshArgs = parts.slice(3); // ["ssh", "user@host", ...]
        if (sshArgs[0] !== 'ssh') continue;

        // Find the destination (skip flags like -p, -i, etc.)
        let destination = null;
        for (let i = 1; i < sshArgs.length; i++) {
          const arg = sshArgs[i];
          // Skip flags that take a value
          if (/^-[bcDeFIiJLlmOopQRSWw]$/.test(arg)) {
            i++; // skip the value too
            continue;
          }
          // Skip boolean flags
          if (arg.startsWith('-')) continue;
          // This should be the destination
          destination = arg;
          break;
        }

        if (!destination) continue;

        // Parse user@host
        let user = null;
        let host = destination;
        if (destination.includes('@')) {
          [user, host] = destination.split('@', 2);
        }

        sessions.push({
          id: `ssh-${host}-${pid}`,
          pid,
          tty,
          host,
          user,
          elapsed,
          elapsedMs,
        });
      }
    } catch { /* no SSH sessions */ }

    return sessions;
  }

  /**
   * Parse ps elapsed time format to milliseconds.
   */
  parseElapsed(elapsed) {
    if (!elapsed) return 0;
    let days = 0, hours = 0, minutes = 0, seconds = 0;

    if (elapsed.includes('-')) {
      const [dayPart, timePart] = elapsed.split('-');
      days = parseInt(dayPart, 10);
      elapsed = timePart;
    }

    const parts = elapsed.split(':').map(Number);
    if (parts.length === 3) {
      [hours, minutes, seconds] = parts;
    } else if (parts.length === 2) {
      [minutes, seconds] = parts;
    } else if (parts.length === 1) {
      [seconds] = parts;
    }

    return ((days * 24 + hours) * 3600 + minutes * 60 + seconds) * 1000;
  }

  formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m`;
    }
    return `${seconds}s`;
  }

  /**
   * Poll once: detect sessions, track CPU time deltas, emit events.
   *
   * Uses UNION approach — merges three sources to catch all sessions:
   * 1. Debug files with fresh mtime → active sessions (best project info)
   * 2. Process scanning → catches idle sessions with stale debug files
   * 3. SSH connections → detects remote sessions on other machines
   *
   * Sessions are deduplicated by cwd/host to avoid double-counting.
   */
  poll() {
    const debugSessions = this.scanDebugFiles();
    const processes = this.scanProcesses();
    const sshSessions = this.scanSSHSessions();

    // Build union of sessions, keyed by cwd (or fallback to id)
    const sessionMap = new Map(); // cwd -> session info

    // First, add debug-file sessions (best project info)
    for (const ds of debugSessions) {
      const key = ds.cwd || ds.sessionId;
      sessionMap.set(key, {
        id: ds.sessionId,
        cwd: ds.cwd,
        project: ds.project,
        mtime: ds.mtime,
        ageMs: ds.ageMs,
        pid: null,
        tty: null,
        elapsed: null,
        elapsedMs: 0,
        cpuTimeSec: 0,
        remote: false,
      });
    }

    // Then, merge process info (provides CPU time + catches stale-debug sessions)
    for (const proc of processes) {
      const key = proc.cwd || `pid-${proc.pid}`;
      if (sessionMap.has(key)) {
        // Enrich existing debug-file session with process data
        const existing = sessionMap.get(key);
        existing.pid = proc.pid;
        existing.tty = proc.tty;
        existing.elapsed = proc.elapsed;
        existing.elapsedMs = proc.elapsedMs;
        existing.cpuTimeSec = proc.cpuTimeSec;
      } else {
        // Process-only session (debug file is stale or missing)
        sessionMap.set(key, {
          id: `pid-${proc.pid}`,
          cwd: proc.cwd,
          project: proc.project,
          mtime: null,
          ageMs: null,
          pid: proc.pid,
          tty: proc.tty,
          elapsed: proc.elapsed,
          elapsedMs: proc.elapsedMs,
          cpuTimeSec: proc.cpuTimeSec,
          remote: false,
        });
      }
    }

    // Finally, add SSH remote sessions (always separate — different machines)
    for (const ssh of sshSessions) {
      const key = `ssh-${ssh.host}`;
      if (!sessionMap.has(key)) {
        const label = ssh.user ? `${ssh.user}@${ssh.host}` : ssh.host;
        sessionMap.set(key, {
          id: ssh.id,
          cwd: null,
          project: `remote:${label}`,
          mtime: null,
          ageMs: null,
          pid: ssh.pid,
          tty: ssh.tty,
          elapsed: ssh.elapsed,
          elapsedMs: ssh.elapsedMs,
          cpuTimeSec: 0, // can't track remote CPU
          remote: true,
        });
      }
    }

    const currentSessions = Array.from(sessionMap.values());

    const currentIds = new Set(currentSessions.map(s => s.id));

    for (const sess of currentSessions) {
      if (!this.sessions.has(sess.id)) {
        // New session detected
        const session = {
          id: sess.id,
          pid: sess.pid,
          tty: sess.tty,
          cwd: sess.cwd,
          project: sess.project,
          remote: sess.remote || false,
          startedAt: sess.elapsedMs > 0
            ? new Date(Date.now() - sess.elapsedMs)
            : new Date(),
          elapsedMs: sess.elapsedMs,
          lastCpuTimeSec: sess.cpuTimeSec,
          cpuDelta: 0,
          busy: sess.remote ? true : false, // remote sessions assumed busy
          idlePolls: 0,
          busySince: sess.remote ? new Date() : null,
        };
        this.sessions.set(sess.id, session);

        const elapsed = sess.elapsedMs > 0
          ? ` (running ${this.formatDuration(sess.elapsedMs)})`
          : '';
        console.log(`Session detected: ${sess.project || sess.id}${elapsed}`);
        this.emit('session-started', { ...session, status: 'unknown' });
      } else {
        // Existing session — update and track CPU delta
        const existing = this.sessions.get(sess.id);
        if (sess.elapsedMs > 0) existing.elapsedMs = sess.elapsedMs;
        if (sess.cwd) existing.cwd = sess.cwd;
        if (sess.project) existing.project = sess.project;
        if (sess.pid) existing.pid = sess.pid;

        // CPU time delta for busy/idle detection (only if we have process info)
        // Skip for remote sessions — we can't track their CPU usage
        if (sess.cpuTimeSec > 0 && !existing.remote) {
          const cpuDelta = sess.cpuTimeSec - existing.lastCpuTimeSec;
          existing.lastCpuTimeSec = sess.cpuTimeSec;
          existing.cpuDelta = cpuDelta;

          const wasActive = existing.busy;
          const isIdle = cpuDelta < CPU_DELTA_IDLE_THRESHOLD;

          if (isIdle) {
            existing.idlePolls = (existing.idlePolls || 0) + 1;
          } else {
            existing.idlePolls = 0;
          }

          if (wasActive && existing.idlePolls >= IDLE_CONFIRM_POLLS) {
            // Transition: busy -> idle (task finished)
            existing.busy = false;
            const busyMs = existing.busySince
              ? Date.now() - existing.busySince.getTime()
              : 0;
            const busyDuration = busyMs > 0
              ? this.formatDuration(busyMs)
              : 'unknown';
            existing.busySince = null;

            if (busyMs >= MIN_BUSY_DURATION_MS) {
              console.log(`Session task finished: ${existing.project || existing.id} (ran for ${busyDuration})`);
              this.emit('session-task-finished', {
                id: existing.id,
                pid: existing.pid,
                project: existing.project,
                cwd: existing.cwd,
                busyDuration,
              });
            } else {
              console.log(`Session idle: ${existing.project || existing.id} (busy only ${busyDuration}, skipping notification)`);
            }
          } else if (!wasActive && !isIdle) {
            // Transition: idle -> busy (task started)
            existing.busy = true;
            existing.idlePolls = 0;
            existing.busySince = new Date();

            console.log(`Session task started: ${existing.project || existing.id} (CPU delta ${cpuDelta.toFixed(1)}s)`);
            this.emit('session-task-started', {
              id: existing.id,
              pid: existing.pid,
              project: existing.project,
              cwd: existing.cwd,
            });
          }
        }
      }
    }

    // Detect ended sessions
    for (const [id, session] of this.sessions) {
      if (!currentIds.has(id)) {
        this.sessions.delete(id);
        const duration = session.elapsedMs > 0
          ? this.formatDuration(session.elapsedMs)
          : 'unknown';
        console.log(`Session ended: ${session.project || id} (was running ${duration})`);

        this.emit('session-ended', {
          ...session,
          endedAt: new Date(),
          duration,
        });
      }
    }

    // Summary update
    const sessions = this.getSessions();
    const busyCount = sessions.filter(s => s.busy).length;

    this.emit('sessions-updated', {
      count: this.sessions.size,
      busyCount,
      idleCount: this.sessions.size - busyCount,
      sessions,
    });
  }

  getSessions() {
    return Array.from(this.sessions.values()).map(s => ({
      id: s.id,
      pid: s.pid,
      tty: s.tty,
      cwd: s.cwd,
      project: s.project,
      remote: s.remote || false,
      startedAt: s.startedAt,
      elapsed: s.elapsedMs > 0 ? this.formatDuration(s.elapsedMs) : 'active',
      elapsedMs: s.elapsedMs,
      busy: s.busy,
      cpuDelta: s.cpuDelta,
    }));
  }

  start() {
    console.log(`Session monitor started (polling every ${this.pollIntervalMs / 1000}s, hybrid debug-file + process + SSH detection)`);
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), this.pollIntervalMs);
  }

  stop() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}

module.exports = SessionMonitor;
