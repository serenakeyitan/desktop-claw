#!/usr/bin/env node

const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Simple function to strip ANSI escape codes
function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\u001b\[[0-9;]*m/g, '');
}

class SimplUsageFetcher {
  constructor() {
    this.usageFile = path.join(os.homedir(), '.openclaw-pet', 'real-usage.json');
  }

  // Try to get usage using script command for terminal emulation
  async fetchUsage() {
    console.log('Fetching Claude usage with script command...');

    return new Promise((resolve) => {
      const scriptFile = '/tmp/claude-output-' + Date.now() + '.txt';

      // Use script command to capture terminal output properly
      const cmd = `script -q ${scriptFile} bash -c 'echo "/usage" | timeout 5 claude 2>&1 | head -100; exit' && cat ${scriptFile}`;

      exec(cmd, { timeout: 10000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        try {
          // Clean ANSI escape sequences
          const cleaned = stripAnsi(stdout || stderr || '');

          console.log('Raw output length:', cleaned.length);

          // Look for usage patterns
          const patterns = [
            /5-hour:\s*(\d+)%/i,
            /Usage:\s*(\d+)%/i,
            /(\d+)%\s*(?:used|of)/i,
            /Current usage:\s*(\d+)%/i,
            /Model usage:\s*(\d+)%/i
          ];

          for (const pattern of patterns) {
            const match = cleaned.match(pattern);
            if (match) {
              const percentage = parseInt(match[1]);
              console.log(`Found usage pattern: ${percentage}%`);

              // Clean up temp file
              try { fs.unlinkSync(scriptFile); } catch (e) {}

              resolve(percentage);
              return;
            }
          }

          // Try to find any percentage in the output
          const anyPercent = cleaned.match(/(\d+)%/);
          if (anyPercent) {
            const percentage = parseInt(anyPercent[1]);
            console.log(`Found percentage: ${percentage}%`);

            // Clean up temp file
            try { fs.unlinkSync(scriptFile); } catch (e) {}

            resolve(percentage);
            return;
          }

          // Debug: show a portion of the cleaned output
          console.log('Could not find usage in output. Sample:');
          console.log(cleaned.substring(0, 500));

        } catch (e) {
          console.error('Error parsing output:', e);
        }

        // Clean up temp file
        try { fs.unlinkSync(scriptFile); } catch (e) {}
        resolve(null);
      });
    });
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
      source: 'simple-fetcher'
    };

    fs.writeFileSync(this.usageFile, JSON.stringify(usageData, null, 2));
    console.log(`✅ Saved usage: ${percentage}%`);
    console.log(`Data saved to: ${this.usageFile}`);
  }

  async run() {
    const usage = await this.fetchUsage();
    if (usage !== null) {
      this.saveUsage(usage);
      return true;
    } else {
      console.log('Failed to fetch usage');
      return false;
    }
  }
}

// If run directly
if (require.main === module) {
  const fetcher = new SimplUsageFetcher();
  fetcher.run().then(success => {
    process.exit(success ? 0 : 1);
  });
}

module.exports = SimplUsageFetcher;