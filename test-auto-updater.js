#!/usr/bin/env node

const AutoUsageUpdater = require('./auto-usage-updater');

async function test() {
  console.log('Testing Auto Usage Updater...\n');

  const updater = new AutoUsageUpdater();

  const success = await updater.update();

  if (success) {
    console.log('\n✅ Auto-updater successfully fetched usage!');
    console.log('Check ~/.openclaw-pet/real-usage.json for the data');
  } else {
    console.log('\n❌ Auto-updater could not fetch usage');
    console.log('Make sure Claude Code is installed and you\'re logged in');
  }
}

test();