const EventEmitter = require('events');
const pty = require('node-pty');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { getClaudeBinaryPath, checkClaudeAuth } = require('./claude-path');

class ClaudeUsageFetcher extends EventEmitter {
  constructor() {
    super();
    this.claudeProcess = null;
    this.usageData = null;
    this.isReady = false;
    this.outputBuffer = '';
    this.pendingUsageResolve = null;
    this.pendingUsageReject = null;
    this.pendingUsageTimeout = null;
    this.fetchPromise = null;
    this.startPromise = null;
    this.maxBufferLength = 10000;
    this.usageFile = path.join(os.homedir(), '.openclaw-pet', 'real-usage.json');
    this.claudeBinary = null;
  }

  cleanChunk(chunk) {
    if (!chunk) return '';
    return chunk.toString()
      .replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '')
      .replace(/\u001b\[[0-9]+[GKJ]/g, '')
      .replace(/\u001b\[[0-9;]*m/g, '')
      .replace(/\r/g, '');
  }

  appendToBuffer(text) {
    if (!text) return;
    this.outputBuffer += text;
    if (this.outputBuffer.length > this.maxBufferLength) {
      this.outputBuffer = this.outputBuffer.slice(-this.maxBufferLength);
    }
  }

  isPromptDetected(output) {
    if (!output) return false;

    // Check for various prompt patterns
    const promptPatterns = [
      'How can I help',
      'desktop_bot',
      'Claude Code',
      'Enter a prompt',
      'What would you like',
      'Ready to assist',
      'Available commands',
      'Type /help',
      'Welcome to Claude'
    ];

    for (const pattern of promptPatterns) {
      if (output.includes(pattern)) return true;
    }

    // Check if ends with prompt character
    const trimmed = output.trim();
    if (trimmed.endsWith('>') || trimmed.endsWith('$') || trimmed.endsWith('#')) {
      return true;
    }

    // Check if we have substantial output (indicates session is ready)
    if (trimmed.length > 100) {
      return true;
    }

    return false;
  }

  finishPendingUsage(usage, error) {
    if (this.pendingUsageTimeout) {
      clearTimeout(this.pendingUsageTimeout);
      this.pendingUsageTimeout = null;
    }

    const resolve = this.pendingUsageResolve;
    const reject = this.pendingUsageReject;
    this.pendingUsageResolve = null;
    this.pendingUsageReject = null;

    if (error && reject) {
      reject(error);
    } else if (usage && resolve) {
      resolve(usage);
    }

    this.outputBuffer = '';
  }

  ensureClaudeBinary() {
    if (!this.claudeBinary) {
      this.claudeBinary = getClaudeBinaryPath();
      console.log('Using Claude CLI binary:', this.claudeBinary);
    }
    return this.claudeBinary;
  }

  async start() {
    if (this.isReady && this.claudeProcess) {
      return true;
    }

    if (this.startPromise) {
      return this.startPromise;
    }

    const sessionPromise = this.createSession();
    this.startPromise = sessionPromise;

    try {
      return await sessionPromise;
    } finally {
      if (this.startPromise === sessionPromise) {
        this.startPromise = null;
      }
    }
  }

  createSession() {
    return new Promise(async (resolve, reject) => {
      console.log('Starting Claude Code session for usage monitoring...');

      // Check authentication first
      const authCheck = checkClaudeAuth();
      if (!authCheck.authenticated) {
        console.log('Claude authentication check failed:', authCheck.message);
        console.log('Please run "claude setup-token" to authenticate first');
        reject(new Error('Claude CLI not authenticated. Run "claude setup-token" first.'));
        return;
      }

      let claudeBinary;
      try {
        claudeBinary = this.ensureClaudeBinary();
      } catch (error) {
        reject(error);
        return;
      }

      let startSettled = false;
      let sessionReady = false;
      let readyTimeout;
      this.outputBuffer = '';

      const settleSuccess = () => {
        if (startSettled) return;
        startSettled = true;
        sessionReady = true;
        clearTimeout(readyTimeout);
        console.log('Claude Code session ready');
        resolve(true);
      };

      const settleFailure = (error) => {
        if (startSettled) return;
        startSettled = true;
        clearTimeout(readyTimeout);
        reject(error);
      };

      try {
        this.claudeProcess = pty.spawn(claudeBinary, [], {
          name: 'xterm-256color',
          cols: 120,
          rows: 40,
          cwd: process.cwd(),
          env: { ...process.env, TERM: 'xterm-256color' }
        });
      } catch (error) {
        settleFailure(error);
        return;
      }

      readyTimeout = setTimeout(() => {
        if (!sessionReady) {
          this.stop();
          settleFailure(new Error('Claude authentication timeout after 60s - please login to Claude Code first'));
        }
      }, 60000); // Increased from 10s to 60s for Claude initialization

      this.claudeProcess.on('data', (data) => {
        const cleaned = this.cleanChunk(data);
        this.appendToBuffer(cleaned);

        if (!sessionReady && this.isPromptDetected(this.outputBuffer)) {
          this.isReady = true;
          settleSuccess();
        }

        if (this.pendingUsageResolve) {
          const usage = this.parseUsageFromOutput(this.outputBuffer);
          if (usage) {
            this.finishPendingUsage(usage);
          }
        }
      });

      this.claudeProcess.on('exit', (code) => {
        console.log('Claude process exited with code', code);
        const exitError = new Error('Claude process exited');

        if (!sessionReady) {
          settleFailure(exitError);
        } else {
          this.emit('disconnected');
        }

        this.isReady = false;
        this.claudeProcess = null;
        this.finishPendingUsage(null, exitError);
      });

      this.claudeProcess.on('error', (error) => {
        console.error('Failed to start Claude:', error);
        settleFailure(error);
      });
    });
  }

  async fetchUsage() {
    if (this.fetchPromise) {
      return this.fetchPromise;
    }

    if (!this.claudeProcess || !this.isReady) {
      await this.start();
    }

    this.fetchPromise = new Promise((resolve, reject) => {
      this.pendingUsageResolve = resolve;
      this.pendingUsageReject = reject;
      this.outputBuffer = '';

      this.pendingUsageTimeout = setTimeout(() => {
        this.finishPendingUsage(null, new Error('Usage fetch timeout'));
      }, 60000);  // Increased from 10s to 60s for Claude response

      try {
        this.claudeProcess.write('/usage\r');
      } catch (error) {
        this.finishPendingUsage(null, error);
      }
    });

    try {
      return await this.fetchPromise;
    } finally {
      this.fetchPromise = null;
    }
  }

  parseUsageFromOutput(outputText = '') {
    const output = outputText || this.outputBuffer;
    if (!output || output.trim().length === 0) {
      return null;
    }

    const fiveHourPattern = /5-hour.*?(\d+)%.*?resets in ([\d.]+) (hours?|minutes?)/i;
    const fiveHourMatch = output.match(fiveHourPattern);

    const sevenDayPattern = /7-day.*?(\d+)%.*?resets in ([\d.]+) (days?|hours?)/i;
    const sevenDayMatch = output.match(sevenDayPattern);

    const messagePattern = /(\d+)\s*\/\s*(\d+)\s*messages/i;
    const messageMatch = output.match(messagePattern);

    const percentPattern = /(?:current\s+)?usage[:\s]+(\d+)%/i;
    const percentMatch = output.match(percentPattern);

    if (!fiveHourMatch && !sevenDayMatch && !messageMatch && !percentMatch) {
      return null;
    }

    const usage = {
      fiveHour: null,
      sevenDay: null,
      messages: null,
      subscription: 'Claude Pro',
      timestamp: new Date().toISOString()
    };

    if (fiveHourMatch) {
      const percentage = parseInt(fiveHourMatch[1], 10);
      const resetValue = parseFloat(fiveHourMatch[2]);
      const resetUnit = fiveHourMatch[3];
      const resetHours = resetUnit.includes('hour') ? resetValue : resetValue / 60;
      const resetAt = new Date(Date.now() + resetHours * 60 * 60 * 1000);

      usage.fiveHour = {
        percentage,
        used: percentage,
        limit: 100,
        resetAt: resetAt.toISOString()
      };
    }

    if (sevenDayMatch) {
      const percentage = parseInt(sevenDayMatch[1], 10);
      const resetValue = parseFloat(sevenDayMatch[2]);
      const resetUnit = sevenDayMatch[3];
      const resetHours = resetUnit.includes('day') ? resetValue * 24 : resetValue;
      const resetAt = new Date(Date.now() + resetHours * 60 * 60 * 1000);

      usage.sevenDay = {
        percentage,
        used: percentage,
        limit: 100,
        resetAt: resetAt.toISOString()
      };
    }

    if (messageMatch) {
      const used = parseInt(messageMatch[1], 10);
      const limit = parseInt(messageMatch[2], 10);
      usage.messages = {
        used,
        limit,
        percentage: Math.round((used / limit) * 100)
      };
    }

    if (percentMatch && !usage.fiveHour) {
      const percentage = parseInt(percentMatch[1], 10);
      usage.fiveHour = {
        percentage,
        used: percentage,
        limit: 100,
        resetAt: new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString()
      };
    }

    if (output.includes('Claude Team')) {
      usage.subscription = 'Claude Team';
    } else if (output.includes('Claude Max') || output.includes('Claude Opus')) {
      usage.subscription = 'Claude Max';
    } else if (output.includes('Claude Free')) {
      usage.subscription = 'Claude Free';
    }

    this.usageData = usage;
    this.emit('usage-updated', usage);
    this.persistPrimaryUsage();
    console.log('Parsed usage data:', usage);

    return usage;
  }

  getPrimaryUsage() {
    if (!this.usageData) return null;

    if (this.usageData.fiveHour) {
      return {
        used: this.usageData.fiveHour.used,
        limit: this.usageData.fiveHour.limit,
        percentage: this.usageData.fiveHour.percentage,
        resetAt: this.usageData.fiveHour.resetAt,
        subscription: this.usageData.subscription,
        type: '5-hour',
        realData: true
      };
    }

    if (this.usageData.messages) {
      return {
        used: this.usageData.messages.used,
        limit: this.usageData.messages.limit,
        percentage: this.usageData.messages.percentage,
        resetAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        subscription: this.usageData.subscription,
        type: 'messages',
        realData: true
      };
    }

    return null;
  }

  persistPrimaryUsage() {
    const primary = this.getPrimaryUsage();
    if (!primary) return;

    const payload = {
      percentage: primary.percentage,
      pct: primary.percentage,
      used: primary.used,
      limit: primary.limit,
      resetAt: primary.resetAt,
      reset_at: primary.resetAt,
      subscription: primary.subscription,
      type: primary.type,
      realData: true,
      timestamp: new Date().toISOString(),
      source: 'claude-live-fetcher'
    };

    try {
      const dir = path.dirname(this.usageFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.usageFile, JSON.stringify(payload, null, 2));
    } catch (error) {
      console.error('Failed to persist usage data:', error.message);
    }
  }

  startPeriodicCheck(intervalMinutes = 5) {
    this.fetchUsage().catch((error) => {
      console.error('Initial usage fetch failed:', error.message);
    });

    this.checkInterval = setInterval(async () => {
      try {
        await this.fetchUsage();
      } catch (error) {
        console.error('Failed to fetch usage:', error);
        this.isReady = false;
        try {
          await this.start();
          await this.fetchUsage();
        } catch (restartError) {
          console.error('Failed to restart Claude session:', restartError);
        }
      }
    }, intervalMinutes * 60 * 1000);
  }

  stop() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }

    if (this.pendingUsageResolve || this.pendingUsageReject) {
      this.finishPendingUsage(null, new Error('Claude usage fetcher stopped'));
    }

    if (this.claudeProcess) {
      try {
        this.claudeProcess.write('exit\r');
      } catch (_) {
        // ignore
      }

      setTimeout(() => {
        if (this.claudeProcess) {
          this.claudeProcess.kill();
          this.claudeProcess = null;
        }
      }, 500);
    }

    this.isReady = false;
  }
}

module.exports = ClaudeUsageFetcher;
