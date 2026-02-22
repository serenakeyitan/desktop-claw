#!/usr/bin/env node

const OpenAIAuth = require('./openai-auth');
const OpenAIUsageFetcher = require('./openai-usage-fetcher');

async function testOpenAIIntegration() {
  console.log('🧪 Testing OpenAI Integration\n');

  // Test 1: Initialize authentication
  console.log('1. Initializing OpenAI Auth...');
  const auth = new OpenAIAuth();

  // Check if we have saved credentials
  if (auth.apiKey) {
    console.log('   ✅ Found saved API key');
  } else if (auth.accessToken) {
    console.log('   ✅ Found saved OAuth token');
  } else {
    console.log('   ⚠️  No saved credentials found');
    console.log('   Please set OPENAI_API_KEY environment variable or run the app to authenticate');

    // Try environment variable
    if (process.env.OPENAI_API_KEY) {
      console.log('   Found OPENAI_API_KEY in environment');
      auth.apiKey = process.env.OPENAI_API_KEY;
      auth.saveApiKey(auth.apiKey);
    } else {
      console.log('\n❌ No authentication available. Exiting...');
      return;
    }
  }

  // Test 2: Fetch usage
  console.log('\n2. Fetching usage data...');
  try {
    const usage = await auth.fetchUsage();
    console.log('   ✅ Successfully fetched usage:');
    console.log(`   - Percentage: ${usage.percentage}%`);
    console.log(`   - Used: $${usage.used}`);
    console.log(`   - Limit: $${usage.limit}`);
    console.log(`   - Subscription: ${usage.subscription}`);
    console.log(`   - Reset: ${new Date(usage.resetAt).toLocaleDateString()}`);
    console.log(`   - Data source: ${usage.source}`);
    console.log(`   - Real data: ${usage.realData ? 'Yes' : 'No (simulated)'}`);
  } catch (error) {
    console.log('   ❌ Failed to fetch usage:', error.message);
  }

  // Test 3: Usage fetcher
  console.log('\n3. Testing OpenAI Usage Fetcher...');
  const fetcher = new OpenAIUsageFetcher();
  fetcher.setAuthManager(auth);

  try {
    await fetcher.start();
    console.log('   ✅ Usage fetcher initialized');

    const primaryUsage = fetcher.getPrimaryUsage();
    if (primaryUsage) {
      console.log('   ✅ Primary usage data available');
    }
  } catch (error) {
    console.log('   ❌ Failed to start fetcher:', error.message);
  }

  // Test 4: Check simulated usage
  console.log('\n4. Testing simulated usage (fallback)...');
  const simulated = auth.getSimulatedUsage();
  console.log('   ✅ Simulated usage:');
  console.log(`   - Percentage: ${simulated.percentage}%`);
  console.log(`   - Reset: ${new Date(simulated.resetAt).toLocaleDateString()}`);

  console.log('\n✅ OpenAI integration test complete!');
  console.log('\nTo use the app:');
  console.log('1. Run: npm start');
  console.log('2. Choose OAuth login or enter API key');
  console.log('3. The pet will show your OpenAI usage');

  process.exit(0);
}

// Run test
testOpenAIIntegration().catch(error => {
  console.error('Test failed:', error);
  process.exit(1);
});