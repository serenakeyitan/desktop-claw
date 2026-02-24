#!/usr/bin/env node

const { spawn } = require('child_process');
const stripAnsi = require('strip-ansi');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Install strip-ansi if needed
function ensureStripAnsi() {
  try {
    require('strip-ansi');
  } catch (e) {
    console.log('Installing strip-ansi package...');
    require('child_process').execSync('npm install strip-ansi', { stdio: 'inherit' });
  }
}

ensureStripAnsi();

class ClaudeUsageAPI {
  constructor() {
    this.usageFile = path.join(os.homedir(), '.alldaypoke', 'real-usage.json');
  }

  // Try to get usage using script command for terminal emulation
  async fetchUsageWithScript() {
    return new Promise((resolve) => {
      const scriptFile = '/tmp/claude-output.txt';

      // Use script command to capture terminal output properly
      const cmd = `script -q ${scriptFile} sh -c 'echo "/usage" | claude 2>&1 | head -50; exit' && cat ${scriptFile}`;

      require('child_process').exec(cmd, { timeout: 10000 }, (error, stdout, stderr) => {
        try {
          // Clean ANSI escape sequences
          const cleaned = stripAnsi(stdout);

          // Look for usage patterns
          const patterns = [
            /5-hour:\s*(\d+)%/i,
            /Usage:\s*(\d+)%/i,
            /(\d+)%\s*(?:used|of)/i,
            /Current usage:\s*(\d+)%/i
          ];

          for (const pattern of patterns) {
            const match = cleaned.match(pattern);
            if (match) {
              const percentage = parseInt(match[1]);
              console.log(`Found usage: ${percentage}%`);
              resolve(percentage);
              return;
            }
          }

          // Try to find any percentage
          const anyPercent = cleaned.match(/(\d+)%/);
          if (anyPercent) {
            resolve(parseInt(anyPercent[1]));
            return;
          }
        } catch (e) {
          console.error('Error parsing output:', e);
        }

        resolve(null);
      });

      // Clean up temp file after a delay
      setTimeout(() => {
        try {
          fs.unlinkSync(scriptFile);
        } catch (e) {}
      }, 5000);
    });
  }

  // Try using pty.js for proper terminal emulation
  async fetchUsageWithPty() {
    try {
      // Try to use node-pty if available
      const pty = require('node-pty');

      return new Promise((resolve) => {
        const ptyProcess = pty.spawn('claude', [], {
          name: 'xterm-color',
          cols: 80,
          rows: 30,
          cwd: process.env.HOME,
          env: process.env
        });

        let output = '';
        let timeout;

        ptyProcess.on('data', (data) => {
          output += data;

          // Look for usage after sending command
          if (output.includes('/usage')) {
            clearTimeout(timeout);
            timeout = setTimeout(() => {
              const cleaned = stripAnsi(output);

              // Parse usage
              const match = cleaned.match(/(\d+)%/);
              if (match) {
                const percentage = parseInt(match[1]);
                ptyProcess.kill();
                resolve(percentage);
              } else {
                ptyProcess.kill();
                resolve(null);
              }
            }, 2000);
          }
        });

        // Wait for prompt then send command
        setTimeout(() => {
          ptyProcess.write('/usage\r');
        }, 1000);

        // Timeout fallback
        setTimeout(() => {
          ptyProcess.kill();
          resolve(null);
        }, 10000);
      });
    } catch (e) {
      console.log('node-pty not available, skipping PTY method');
      return null;
    }
  }

  // Main method to fetch usage
  async fetchUsage() {
    console.log('Fetching Claude usage...');

    // Try PTY method first (best)
    let usage = await this.fetchUsageWithPty();

    // Fallback to script method
    if (usage === null) {
      usage = await this.fetchUsageWithScript();
    }

    if (usage !== null) {
      this.saveUsage(usage);
      return usage;
    }

    console.log('Could not fetch usage');
    return null;
  }

  saveUsage(percentage) {
    const dir = path.dirname(this.usageFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const resetAt = new Date(Date.now() + 5 * 60 * 60 * 1000);

    const usageData = {
      percentage: percentage,
      used: percentage,
      limit: 100,
      resetAt: resetAt.toISOString(),
      subscription: 'Claude Pro',
      type: '5-hour',
      realData: true,
      timestamp: new Date().toISOString(),
      source: 'claude-usage-api'
    };

    fs.writeFileSync(this.usageFile, JSON.stringify(usageData, null, 2));
    console.log(`✅ Saved usage: ${percentage}%`);
    console.log(`Data saved to: ${this.usageFile}`);
  }
}

// If run directly
if (require.main === module) {
  const api = new ClaudeUsageAPI();
  api.fetchUsage().then(usage => {
    if (usage !== null) {
      console.log(`\nSuccessfully fetched usage: ${usage}%`);
      process.exit(0);
    } else {
      console.log('\nFailed to fetch usage');
      process.exit(1);
    }
  });
}

module.exports = ClaudeUsageAPI;