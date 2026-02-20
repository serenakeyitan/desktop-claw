#!/usr/bin/env node

const ClaudeUsageFetcher = require('./claude-usage-fetcher');

async function testFetcher() {
  console.log('Testing ClaudeUsageFetcher...\n');

  const fetcher = new ClaudeUsageFetcher();

  fetcher.on('usage-updated', (data) => {
    console.log('\n📊 Received usage update:');
    console.log('  Subscription:', data.subscription);
    if (data.fiveHour) {
      console.log('  5-hour usage:', data.fiveHour.percentage + '%');
      console.log('  Reset at:', new Date(data.fiveHour.resetAt).toLocaleString());
    }
    if (data.sevenDay) {
      console.log('  7-day usage:', data.sevenDay.percentage + '%');
      console.log('  Reset at:', new Date(data.sevenDay.resetAt).toLocaleString());
    }
    if (data.messages) {
      console.log('  Messages:', data.messages.used + '/' + data.messages.limit);
    }
  });

  try {
    console.log('Starting Claude Code session...');
    await fetcher.start();
    console.log('✓ Claude session started\n');

    console.log('Fetching usage data...');
    const usage = await fetcher.fetchUsage();

    if (usage) {
      console.log('\n✅ Successfully fetched usage:');
      console.log(JSON.stringify(usage, null, 2));

      const primaryUsage = fetcher.getPrimaryUsage();
      if (primaryUsage) {
        console.log('\nPrimary usage for display:');
        console.log(JSON.stringify(primaryUsage, null, 2));
      }
    } else {
      console.log('❌ No usage data returned');
    }

    // Keep running for a bit to see if we get any updates
    console.log('\nWaiting for 10 seconds for any additional output...');
    await new Promise(resolve => setTimeout(resolve, 10000));

  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    console.log('\nStopping fetcher...');
    fetcher.stop();
    process.exit(0);
  }
}

testFetcher();