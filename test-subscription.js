#!/usr/bin/env node

const OpenAISubscriptionAuth = require('./openai-subscription-auth');

async function testSubscription() {
  console.log('🧪 Testing ChatGPT Plus Subscription Tracking\n');

  // Test 1: Initialize auth
  console.log('1. Initializing ChatGPT Plus auth...');
  const auth = new OpenAISubscriptionAuth();

  // Test 2: Check for saved session
  console.log('\n2. Checking for saved session...');
  const hasSession = auth.loadSavedSession();

  if (hasSession) {
    console.log('   ✅ Found saved ChatGPT session');

    // Test 3: Get usage data
    console.log('\n3. Getting current usage data...');
    const usage = auth.getUsageData();

    console.log('   📊 Current Usage:');
    console.log(`   - Messages used: ${usage.used}/${usage.limit}`);
    console.log(`   - Percentage: ${usage.percentage}%`);
    console.log(`   - Model: ${usage.model}`);
    console.log(`   - Reset in: ${Math.floor(usage.resetIn / 60)} minutes`);
    console.log(`   - Reset at: ${new Date(usage.resetAt).toLocaleString()}`);

    // Test 4: Simulate sending a message
    console.log('\n4. Simulating message sent...');
    auth.trackMessage('gpt-4');

    const newUsage = auth.getUsageData();
    console.log(`   ✅ Updated usage: ${newUsage.used}/${newUsage.limit} (${newUsage.percentage}%)`);

  } else {
    console.log('   ❌ No saved session found');
    console.log('\n📝 To set up ChatGPT Plus tracking:');
    console.log('   1. Run: npm start');
    console.log('   2. Click "Login to ChatGPT"');
    console.log('   3. Sign in with your OpenAI account');

    // Test 5: Show simulated usage
    console.log('\n5. Showing simulated usage for demo...');
    const simulated = auth.simulateUsage();

    console.log('   📊 Simulated Usage:');
    console.log(`   - Messages: ${simulated.used}/${simulated.limit}`);
    console.log(`   - Percentage: ${simulated.percentage}%`);
    console.log(`   - Reset at: ${new Date(simulated.resetAt).toLocaleString()}`);
  }

  // Test 6: Check GPT-4 limits
  console.log('\n6. ChatGPT Plus GPT-4 Limits:');
  console.log('   • 80 messages every 3 hours');
  console.log('   • Automatic reset after window expires');
  console.log('   • Unlimited GPT-3.5 messages');

  console.log('\n✅ Test complete!');
  console.log('\n💡 Tips:');
  console.log('   - Usage is tracked locally based on activity');
  console.log('   - Manual updates available via right-click menu');
  console.log('   - Check ChatGPT directly for exact usage');

  process.exit(0);
}

// Run test
testSubscription().catch(error => {
  console.error('Test failed:', error);
  process.exit(1);
});