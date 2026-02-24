#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const usageFile = path.join(os.homedir(), '.alldaypoke', 'real-usage.json');

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
    source: 'manual-update'
  };

  fs.writeFileSync(usageFile, JSON.stringify(usageData, null, 2));
  console.log(`✅ Updated usage to ${percentage}%`);
  console.log(`Data saved to: ${usageFile}`);
}

// If a percentage is provided as an argument
if (process.argv[2]) {
  const percentage = parseInt(process.argv[2]);
  if (!isNaN(percentage) && percentage >= 0 && percentage <= 100) {
    saveUsage(percentage);
  } else {
    console.error('Please provide a valid percentage (0-100)');
    process.exit(1);
  }
} else {
  // Interactive mode
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(' 📊 All Day Poke Usage Updater');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log();
  console.log('To update your usage:');
  console.log('1. Run /usage in Claude Code');
  console.log('2. Look for the percentage (e.g., "5-hour: 42%")');
  console.log('3. Enter that percentage below');
  console.log();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  rl.question('Enter current usage percentage (0-100): ', (answer) => {
    const percentage = parseInt(answer);
    if (!isNaN(percentage) && percentage >= 0 && percentage <= 100) {
      saveUsage(percentage);
    } else {
      console.error('Invalid percentage. Please run again with a number between 0 and 100.');
    }
    rl.close();
  });
}