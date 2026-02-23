/**
 * Claude Code Session Monitor
 *
 * Detects active Claude Code sessions by scanning running processes,
 * tracks their lifecycle and activity state (busy vs idle) using
 * cumulative CPU time deltas, and emits events when sessions start,
 * end, or finish a task.
 *
 * Uses cputime (cumulative CPU seconds) instead of %cpu because %cpu
 * from ps on macOS is a lifetime average that stays elevated for
 * long-running processes even when idle.
 */

const { execSync } = require('child_process');
const EventEmitter = require('events');
const path = require('path');

// If a process consumes less than this many CPU-seconds per poll interval,
// it is considered idle (waiting at the prompt). A truly idle Claude process
// uses ~0s of CPU. An active one uses 1-4s per 5-second poll.
const CPU_DELTA_IDLE_THRESHOLD = 0.3; // seconds of CPU per poll

// Number of consecutive idle polls before we declare the session idle.
// With 5s polling this means 30s of sustained idle before "task finished".
const IDLE_CONFIRM_POLLS = 6;

// Minimum busy duration (ms) before a task-finished notification fires.
const MIN_BUSY_DURATION_MS = 30 * 1000; // 30 seconds

class SessionMonitor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.pollIntervalMs = (options.pollIntervalSeconds || 5) * 1000;
    this.pollTimer = null;
    // Map of PID -> session info (includes activity tracking)
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
   * Scan for running Claude Code processes.
   * Returns an array of { pid, tty, elapsed, cpuTimeSec, cwd, ... } objects.
   */
  scanProcesses() {
    try {
      // ps -eo: PID TTY ELAPSED CPUTIME COMMAND
      const raw = execSync(
        `ps -eo pid,tty,etime,cputime,comm | grep -w "claude$" | grep -v grep`,
        { encoding: 'utf8', timeout: 5000 }
      ).trim();

      if (!raw) return [];

      const processes = [];

      for (const line of raw.split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 5) continue;

        const pid = parseInt(parts[0], 10);
        const tty = parts[1];
        const elapsed = parts[2]; // [[DD-]HH:]MM:SS
        const cputime = parts[3]; // MM:SS.xx or HH:MM:SS
        const comm = parts.slice(4).join(' ');

        if (!comm.endsWith('claude')) continue;
        if (isNaN(pid)) continue;

        // Get working directory via lsof
        let cwd = null;
        try {
          const lsofOut = execSync(
            `lsof -a -d cwd -p ${pid} -Fn 2>/dev/null | grep "^n/"`,
            { encoding: 'utf8', timeout: 3000 }
          ).trim();
          if (lsofOut) {
            cwd = lsofOut.replace(/^n/, '');
          }
        } catch {
          // lsof might fail for some processes
        }

        processes.push({
          pid,
          tty: tty === '??' ? null : tty,
          elapsed,
          elapsedMs: this.parseElapsed(elapsed),
          cpuTimeSec: this.parseCpuTime(cputime),
          cwd,
          project: cwd ? path.basename(cwd) : null,
        });
      }

      return processes;
    } catch {
      return [];
    }
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
   */
  poll() {
    const current = this.scanProcesses();
    const currentPids = new Set(current.map(p => p.pid));

    for (const proc of current) {
      if (!this.sessions.has(proc.pid)) {
        // New session — we don't know its activity state yet (need 2 polls)
        const session = {
          pid: proc.pid,
          tty: proc.tty,
          cwd: proc.cwd,
          project: proc.project,
          startedAt: new Date(Date.now() - proc.elapsedMs),
          elapsedMs: proc.elapsedMs,
          lastCpuTimeSec: proc.cpuTimeSec,
          cpuDelta: 0,
          // Start as idle — will transition to busy on next poll if active
          busy: false,
          idlePolls: 0,
          busySince: null,
        };
        this.sessions.set(proc.pid, session);

        console.log(`Session detected: PID ${proc.pid} in ${proc.project || 'unknown'} (running ${this.formatDuration(proc.elapsedMs)})`);
        this.emit('session-started', { ...session, status: 'unknown' });
      } else {
        // Existing session — compute CPU delta and detect transitions
        const existing = this.sessions.get(proc.pid);
        existing.elapsedMs = proc.elapsedMs;
        if (proc.cwd) existing.cwd = proc.cwd;
        if (proc.project) existing.project = proc.project;

        // CPU time delta since last poll
        const cpuDelta = proc.cpuTimeSec - existing.lastCpuTimeSec;
        existing.lastCpuTimeSec = proc.cpuTimeSec;
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
            console.log(`Session task finished: PID ${proc.pid} in ${existing.project || 'unknown'} (ran for ${busyDuration})`);
            this.emit('session-task-finished', {
              pid: existing.pid,
              project: existing.project,
              cwd: existing.cwd,
              busyDuration,
            });
          } else {
            console.log(`Session idle: PID ${proc.pid} in ${existing.project || 'unknown'} (busy only ${busyDuration}, skipping notification)`);
          }
        } else if (!wasActive && !isIdle) {
          // Transition: idle -> busy (task started)
          existing.busy = true;
          existing.idlePolls = 0;
          existing.busySince = new Date();

          console.log(`Session task started: PID ${proc.pid} in ${existing.project || 'unknown'} (CPU delta ${cpuDelta.toFixed(1)}s)`);
          this.emit('session-task-started', {
            pid: existing.pid,
            project: existing.project,
            cwd: existing.cwd,
          });
        }
      }
    }

    // Detect ended sessions (process exited)
    for (const [pid, session] of this.sessions) {
      if (!currentPids.has(pid)) {
        this.sessions.delete(pid);
        const duration = this.formatDuration(session.elapsedMs);
        console.log(`Session ended: PID ${pid} in ${session.project || 'unknown'} (was running ${duration})`);

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
      pid: s.pid,
      tty: s.tty,
      cwd: s.cwd,
      project: s.project,
      startedAt: s.startedAt,
      elapsed: this.formatDuration(s.elapsedMs),
      elapsedMs: s.elapsedMs,
      busy: s.busy,
      cpuDelta: s.cpuDelta,
    }));
  }

  start() {
    console.log(`Session monitor started (polling every ${this.pollIntervalMs / 1000}s)`);
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
