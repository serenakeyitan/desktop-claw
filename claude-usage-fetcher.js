const { spawn } = require('child_process');
const EventEmitter = require('events');

class ClaudeUsageFetcher extends EventEmitter {
  constructor() {
    super();
    this.claudeProcess = null;
    this.usageData = null;
    this.isReady = false;
    this.outputBuffer = '';
  }

  // Start Claude Code session and authenticate
  async start() {
    return new Promise((resolve, reject) => {
      console.log('Starting Claude Code session for usage monitoring...');

      // Check if claude command exists first
      const claudeTest = spawn('which', ['claude'], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      claudeTest.on('close', (code) => {
        if (code !== 0) {
          console.log('Claude command not found. Make sure Claude Code is installed.');
          reject(new Error('Claude Code not installed or not in PATH'));
          return;
        }

        // Spawn claude in interactive mode
        this.claudeProcess = spawn('claude', [], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env }
        });

        let authTimeout = setTimeout(() => {
          reject(new Error('Claude authentication timeout - please login to Claude Code first'));
        }, 10000);

        // Handle output from Claude
        this.claudeProcess.stdout.on('data', (data) => {
          const output = data.toString();
          this.outputBuffer += output;

          // Check if Claude is ready (look for prompt pattern)
          if (!this.isReady && (output.includes('desktop_bot') || output.includes('How can I help'))) {
            this.isReady = true;
            clearTimeout(authTimeout);
            console.log('Claude Code session ready');
            resolve(true);
          }

          // Parse usage data if present
          this.parseUsageFromOutput();
        });

        this.claudeProcess.stderr.on('data', (data) => {
          console.error('Claude stderr:', data.toString());
        });

        this.claudeProcess.on('error', (error) => {
          console.error('Failed to start Claude:', error);
          reject(error);
        });

        this.claudeProcess.on('close', (code) => {
          console.log('Claude process exited with code', code);
          this.isReady = false;
          this.emit('disconnected');
        });
      });
    });
  }

  // Send /usage command to get real usage data
  async fetchUsage() {
    if (!this.isReady || !this.claudeProcess) {
      console.log('Claude not ready, starting session...');
      await this.start();
    }

    return new Promise((resolve, reject) => {
      console.log('Fetching usage data from Claude...');
      this.outputBuffer = ''; // Clear buffer

      // Send /usage command
      this.claudeProcess.stdin.write('/usage\n');

      // Wait for response and parse it
      let timeout = setTimeout(() => {
        reject(new Error('Usage fetch timeout'));
      }, 10000);

      // Check for usage data in output
      const checkInterval = setInterval(() => {
        const usage = this.parseUsageFromOutput();
        if (usage) {
          clearInterval(checkInterval);
          clearTimeout(timeout);
          resolve(usage);
        }
      }, 500);
    });
  }

  // Parse usage data from Claude output
  parseUsageFromOutput() {
    const output = this.outputBuffer;

    // Look for usage patterns in the output
    // Pattern 1: "5-hour: X% (resets in Y hours)"
    const fiveHourPattern = /5-hour.*?(\d+)%.*?resets in ([\d.]+) (hours?|minutes?)/i;
    const fiveHourMatch = output.match(fiveHourPattern);

    // Pattern 2: "7-day: X% (resets in Y days)"
    const sevenDayPattern = /7-day.*?(\d+)%.*?resets in ([\d.]+) (days?|hours?)/i;
    const sevenDayMatch = output.match(sevenDayPattern);

    // Pattern 3: Alternative format "Your usage: X/Y messages"
    const messagePattern = /(\d+)\s*\/\s*(\d+)\s*messages/i;
    const messageMatch = output.match(messagePattern);

    // Pattern 4: "Usage: X%" or "Current usage: X%"
    const percentPattern = /(?:current\s+)?usage[:\s]+(\d+)%/i;
    const percentMatch = output.match(percentPattern);

    let usage = null;

    if (fiveHourMatch || sevenDayMatch || messageMatch || percentMatch) {
      usage = {
        fiveHour: null,
        sevenDay: null,
        messages: null,
        subscription: 'Claude Pro', // Default, will be updated if we detect otherwise
        timestamp: new Date().toISOString()
      };

      // Parse 5-hour usage
      if (fiveHourMatch) {
        const percentage = parseInt(fiveHourMatch[1]);
        const resetValue = parseFloat(fiveHourMatch[2]);
        const resetUnit = fiveHourMatch[3];

        let resetHours = resetUnit.includes('hour') ? resetValue : resetValue / 60;
        let resetAt = new Date(Date.now() + resetHours * 60 * 60 * 1000);

        usage.fiveHour = {
          percentage: percentage,
          used: percentage, // Treating percentage as usage for display
          limit: 100,
          resetAt: resetAt.toISOString()
        };
      }

      // Parse 7-day usage
      if (sevenDayMatch) {
        const percentage = parseInt(sevenDayMatch[1]);
        const resetValue = parseFloat(sevenDayMatch[2]);
        const resetUnit = sevenDayMatch[3];

        let resetHours = resetUnit.includes('day') ? resetValue * 24 : resetValue;
        let resetAt = new Date(Date.now() + resetHours * 60 * 60 * 1000);

        usage.sevenDay = {
          percentage: percentage,
          used: percentage,
          limit: 100,
          resetAt: resetAt.toISOString()
        };
      }

      // Parse message-based usage
      if (messageMatch) {
        const used = parseInt(messageMatch[1]);
        const limit = parseInt(messageMatch[2]);
        usage.messages = {
          used: used,
          limit: limit,
          percentage: Math.round((used / limit) * 100)
        };
      }

      // Parse simple percentage
      if (percentMatch && !usage.fiveHour) {
        const percentage = parseInt(percentMatch[1]);
        usage.fiveHour = {
          percentage: percentage,
          used: percentage,
          limit: 100,
          resetAt: new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString() // 5 hours default
        };
      }

      // Check for subscription type
      if (output.includes('Claude Pro')) {
        usage.subscription = 'Claude Pro';
      } else if (output.includes('Claude Team')) {
        usage.subscription = 'Claude Team';
      } else if (output.includes('Claude Opus') || output.includes('Claude Max')) {
        usage.subscription = 'Claude Max';
      }

      this.usageData = usage;
      this.emit('usage-updated', usage);
      console.log('Parsed usage data:', usage);
    }

    return usage;
  }

  // Get primary usage for display
  getPrimaryUsage() {
    if (!this.usageData) return null;

    // Prefer 5-hour usage as it's more frequently updated
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

    // Fall back to message usage
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

  // Start periodic usage checking
  startPeriodicCheck(intervalMinutes = 5) {
    // Initial fetch
    this.fetchUsage().catch(console.error);

    // Set up periodic checks
    this.checkInterval = setInterval(async () => {
      try {
        await this.fetchUsage();
      } catch (error) {
        console.error('Failed to fetch usage:', error);
        // Try to restart the session
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

  // Stop the Claude process
  stop() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }

    if (this.claudeProcess) {
      this.claudeProcess.stdin.write('exit\n');
      setTimeout(() => {
        if (this.claudeProcess) {
          this.claudeProcess.kill();
        }
      }, 1000);
      this.claudeProcess = null;
    }

    this.isReady = false;
  }
}

module.exports = ClaudeUsageFetcher;