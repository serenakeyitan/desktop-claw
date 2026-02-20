#!/usr/bin/env node

/**
 * Manual usage updater for OpenClaw Pet
 * Run this script with the usage percentage from Claude Code's /usage command
 * Usage: node manual-usage-update.js <percentage>
 * Example: node manual-usage-update.js 45
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const usageFile = path.join(os.homedir(), '.openclaw-pet', 'real-usage.json');

// Get usage percentage from command line
const percentage = parseInt(process.argv[2]);

if (isNaN(percentage) || percentage < 0 || percentage > 100) {
  console.log('Usage: node manual-usage-update.js <percentage>');
  console.log('Example: node manual-usage-update.js 45');
  console.log('\nRun /usage in Claude Code to get your current usage percentage');
  process.exit(1);
}

// Create directory if it doesn't exist
const dir = path.dirname(usageFile);
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

// Calculate reset time (5 hours from now as default)
const resetAt = new Date(Date.now() + 5 * 60 * 60 * 1000);

// Create usage data
const usageData = {
  percentage: percentage,
  used: percentage,
  limit: 100,
  resetAt: resetAt.toISOString(),
  subscription: 'Claude Pro',
  type: '5-hour',
  realData: true,
  timestamp: new Date().toISOString(),
  source: 'manual update'
};

// Save to file
fs.writeFileSync(usageFile, JSON.stringify(usageData, null, 2));

console.log(`✅ Usage updated to ${percentage}%`);
console.log(`📁 Saved to: ${usageFile}`);
console.log(`⏰ Reset at: ${resetAt.toLocaleString()}`);
console.log('\nThe OpenClaw Pet will now show this real usage data!');