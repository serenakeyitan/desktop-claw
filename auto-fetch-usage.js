#!/usr/bin/env node

const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const usageFile = path.join(os.homedir(), '.alldaypoke', 'real-usage.json');

// Method 1: Try to run claude with /usage command directly
function fetchUsageDirectly() {
  return new Promise((resolve, reject) => {
    console.log('Attempting to fetch usage from Claude Code...');

    // Try running claude with a command that immediately executes /usage
    const claude = spawn('claude', ['--command', '/usage'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env }
    });

    let output = '';
    let errorOutput = '';

    claude.stdout.on('data', (data) => {
      output += data.toString();
    });

    claude.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    claude.on('close', (code) => {
      if (code === 0 && output) {
        resolve(output);
      } else {
        // Try alternative method
        reject(new Error('Direct method failed, trying alternative...'));
      }
    });

    // Send /usage command if needed
    setTimeout(() => {
      claude.stdin.write('/usage\n');
      setTimeout(() => {
        claude.stdin.write('exit\n');
      }, 2000);
    }, 1000);
  });
}

// Method 2: Use echo to pipe command
function fetchUsageWithEcho() {
  return new Promise((resolve, reject) => {
    console.log('Trying echo method...');

    exec('echo "/usage" | claude 2>&1', {
      timeout: 10000,
      maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => {
      if (stdout) {
        resolve(stdout);
      } else {
        reject(new Error('Echo method failed'));
      }
    });
  });
}

// Method 3: Create a temporary script file
function fetchUsageWithScript() {
  return new Promise((resolve, reject) => {
    console.log('Trying script file method...');

    const scriptFile = path.join(os.tmpdir(), 'claude-usage.txt');
    fs.writeFileSync(scriptFile, '/usage\nexit\n');

    exec(`claude < ${scriptFile} 2>&1`, {
      timeout: 10000,
      maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => {
      fs.unlinkSync(scriptFile); // Clean up
      if (stdout) {
        resolve(stdout);
      } else {
        reject(new Error('Script method failed'));
      }
    });
  });
}

// Parse usage from output
function parseUsage(output) {
  console.log('Raw output received:', output.substring(0, 500));

  // Look for patterns like "5-hour: X%" or "Usage: X%"
  const patterns = [
    /5-hour:\s*(\d+)%/i,
    /usage:\s*(\d+)%/i,
    /current usage:\s*(\d+)%/i,
    /(\d+)%\s*(?:of|used)/i,
    /model usage.*?(\d+)%/i
  ];

  for (const pattern of patterns) {
    const match = output.match(pattern);
    if (match && match[1]) {
      return parseInt(match[1]);
    }
  }

  // Try to find any percentage in the output
  const percentMatch = output.match(/(\d+)%/);
  if (percentMatch) {
    return parseInt(percentMatch[1]);
  }

  return null;
}

// Save usage data
function saveUsage(percentage) {
  const dir = path.dirname(usageFile);
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
    source: 'auto-fetch from Claude Code'
  };

  fs.writeFileSync(usageFile, JSON.stringify(usageData, null, 2));

  console.log(`✅ Usage updated to ${percentage}%`);
  console.log(`📁 Saved to: ${usageFile}`);
  console.log(`⏰ Reset at: ${resetAt.toLocaleString()}`);

  return usageData;
}

// Main function
async function autoFetchUsage() {
  let output = '';

  // Try different methods to get usage
  try {
    try {
      output = await fetchUsageDirectly();
    } catch {
      try {
        output = await fetchUsageWithEcho();
      } catch {
        output = await fetchUsageWithScript();
      }
    }
  } catch (error) {
    console.error('❌ All methods failed. Make sure Claude Code is installed and authenticated.');
    console.error('Run "claude" manually first to ensure you are logged in.');
    return null;
  }

  // Parse the usage from output
  const percentage = parseUsage(output);

  if (percentage !== null) {
    const data = saveUsage(percentage);
    console.log('\n🤖 All Day Poke will now show your real usage!');
    return data;
  } else {
    console.error('❌ Could not parse usage percentage from Claude output');
    console.error('Output was:', output.substring(0, 200));
    return null;
  }
}

// Run if called directly
if (require.main === module) {
  autoFetchUsage().then(data => {
    if (data) {
      console.log('\nUsage fetched successfully!');
      process.exit(0);
    } else {
      console.log('\nFailed to fetch usage. Please check Claude Code is working.');
      process.exit(1);
    }
  });
}

module.exports = { autoFetchUsage };