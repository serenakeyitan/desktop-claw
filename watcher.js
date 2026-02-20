const fs = require('fs');
const path = require('path');
const os = require('os');
const EventEmitter = require('events');

class LogWatcher extends EventEmitter {
  constructor() {
    super();
    this.watchers = [];
    this.watchedPaths = new Set(); // Track already watched paths
    this.lastActivityTime = 0;
    this.checkInterval = null;

    // Possible Claude log locations
    this.logPaths = [
      path.join(os.homedir(), '.claude', 'logs'),
      path.join(os.homedir(), '.claude-code', 'logs'),
      path.join(os.homedir(), 'Library', 'Logs', 'Claude'),
      path.join(os.homedir(), '.config', 'claude', 'logs'),
      path.join(os.homedir(), 'AppData', 'Local', 'Claude', 'logs'), // Windows
    ];

    // Also check for process activity
    this.processNames = ['claude', 'claude-code', 'Claude', 'Codex'];
  }

  start() {
    this.setupWatchers();
    this.startProcessMonitor();
  }

  stop() {
    // Clean up file watchers
    this.watchers.forEach(watcher => {
      watcher.close();
    });
    this.watchers = [];
    this.watchedPaths.clear(); // Clear watched paths

    // Stop process monitor
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  setupWatchers() {
    // Try to watch each potential log path
    this.logPaths.forEach(logPath => {
      // Skip if already watching this path
      if (this.watchedPaths.has(logPath)) {
        return;
      }

      if (fs.existsSync(logPath)) {
        try {
          const watcher = fs.watch(logPath, { recursive: true }, (eventType, filename) => {
            if (eventType === 'change' || eventType === 'rename') {
              this.handleFileChange(path.join(logPath, filename));
            }
          });

          this.watchers.push(watcher);
          this.watchedPaths.add(logPath); // Mark as watched
          console.log(`Watching logs at: ${logPath}`);
        } catch (error) {
          console.log(`Could not watch ${logPath}:`, error.message);
        }
      }
    });

    // Also watch for common log files in home directory
    const homeLogFiles = [
      path.join(os.homedir(), 'claude.log'),
      path.join(os.homedir(), '.claude.log'),
      path.join(os.homedir(), 'claude-activity.log')
    ];

    homeLogFiles.forEach(logFile => {
      const dir = path.dirname(logFile);
      const filename = path.basename(logFile);

      // Skip if already watching this directory
      if (this.watchedPaths.has(dir)) {
        return;
      }

      if (fs.existsSync(dir)) {
        try {
          const watcher = fs.watch(dir, (eventType, changedFile) => {
            if (changedFile === filename) {
              this.handleFileChange(logFile);
            }
          });

          this.watchers.push(watcher);
          this.watchedPaths.add(dir); // Mark directory as watched
        } catch (error) {
          // Silently ignore errors for optional paths
        }
      }
    });
  }

  handleFileChange(filepath) {
    const now = Date.now();
    const timeSinceLastActivity = now - this.lastActivityTime;

    // Debounce rapid file changes
    if (timeSinceLastActivity > 500) {
      this.lastActivityTime = now;
      this.emit('activity');

      // Try to read recent content to detect API calls
      this.checkFileContent(filepath);
    }
  }

  checkFileContent(filepath) {
    try {
      // Read last 1KB of file to check for API activity indicators
      const stats = fs.statSync(filepath);
      const bufferSize = Math.min(1024, stats.size);
      const buffer = Buffer.alloc(bufferSize);
      const fd = fs.openSync(filepath, 'r');

      fs.readSync(fd, buffer, 0, bufferSize, Math.max(0, stats.size - bufferSize));
      fs.closeSync(fd);

      const content = buffer.toString('utf8');

      // Look for API-related keywords
      const apiIndicators = [
        'anthropic.com',
        'api.anthropic.com',
        'claude.ai',
        '/v1/messages',
        '/v1/complete',
        'x-api-key',
        'completion',
        'tokens',
        'model:',
        'claude-'
      ];

      const hasApiActivity = apiIndicators.some(indicator =>
        content.toLowerCase().includes(indicator.toLowerCase())
      );

      if (hasApiActivity) {
        this.emit('activity');
      }
    } catch (error) {
      // Ignore read errors
    }
  }

  startProcessMonitor() {
    // Check for running Claude processes every 5 seconds
    this.checkInterval = setInterval(() => {
      this.checkProcesses();
    }, 5000);
  }

  checkProcesses() {
    const platform = os.platform();

    if (platform === 'darwin' || platform === 'linux') {
      // Use ps command on Unix-like systems
      const { exec } = require('child_process');

      exec('ps aux', (error, stdout) => {
        if (!error && stdout) {
          const hasClaudeProcess = this.processNames.some(name =>
            stdout.toLowerCase().includes(name.toLowerCase())
          );

          if (hasClaudeProcess) {
            // Don't emit activity just for process running
            // Process is running, watchers already set up
          }
        }
      });
    } else if (platform === 'win32') {
      // Use tasklist on Windows
      const { exec } = require('child_process');

      exec('tasklist', (error, stdout) => {
        if (!error && stdout) {
          const hasClaudeProcess = this.processNames.some(name =>
            stdout.toLowerCase().includes(name.toLowerCase())
          );

          if (hasClaudeProcess) {
            // Process is running, watchers already set up
          }
        }
      });
    }
  }

  // Alternative method: Watch for network activity on Anthropic endpoints
  watchNetworkActivity() {
    // This would require more sophisticated network monitoring
    // For now, rely on file watching and process monitoring
  }
}

module.exports = LogWatcher;