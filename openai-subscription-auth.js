const EventEmitter = require('events');
const { BrowserWindow, session } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

class OpenAISubscriptionAuth extends EventEmitter {
  constructor() {
    super();
    this.authWindow = null;
    this.sessionCookies = null;
    this.sessionToken = null;
    this.cookieFile = path.join(os.homedir(), '.alldaypoke', 'openai-session.json');
    this.usageLimit = 80; // GPT-4 has ~80 messages per 3 hours for Plus
    this.currentUsage = 0;
    this.resetTime = null;
    this.usageHistory = [];
  }

  // Load saved session
  loadSavedSession() {
    try {
      if (fs.existsSync(this.cookieFile)) {
        const data = JSON.parse(fs.readFileSync(this.cookieFile, 'utf8'));
        this.sessionCookies = data.cookies;
        this.sessionToken = data.token;
        this.currentUsage = data.currentUsage || 0;
        this.resetTime = data.resetTime ? new Date(data.resetTime) : null;
        this.usageHistory = data.usageHistory || [];
        console.log('Loaded saved OpenAI session');
        return true;
      }
    } catch (error) {
      console.error('Failed to load saved session:', error);
    }
    return false;
  }

  // Save session data
  saveSession() {
    try {
      const dir = path.dirname(this.cookieFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const data = {
        cookies: this.sessionCookies,
        token: this.sessionToken,
        currentUsage: this.currentUsage,
        resetTime: this.resetTime ? this.resetTime.toISOString() : null,
        usageHistory: this.usageHistory,
        savedAt: new Date().toISOString()
      };

      fs.writeFileSync(this.cookieFile, JSON.stringify(data, null, 2));
      console.log('Saved OpenAI session');
    } catch (error) {
      console.error('Failed to save session:', error);
    }
  }

  // Start login flow to capture ChatGPT session
  async startLoginFlow() {
    return new Promise((resolve, reject) => {
      console.log('Starting OpenAI ChatGPT login flow...');

      this.authWindow = new BrowserWindow({
        width: 800,
        height: 700,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          partition: 'persist:openai'
        },
        title: 'Login to ChatGPT'
      });

      // Load ChatGPT login page
      this.authWindow.loadURL('https://chat.openai.com/auth/login');

      // Monitor for successful login
      this.authWindow.webContents.on('did-navigate', async (event, url) => {
        console.log('Navigated to:', url);

        // Check if we're on the main ChatGPT page (successful login)
        if (url.includes('chat.openai.com') && !url.includes('/auth/')) {
          console.log('Login successful, capturing session...');

          try {
            // Get all cookies
            const cookies = await this.authWindow.webContents.session.cookies.get({
              domain: '.openai.com'
            });

            // Look for session token
            const sessionCookie = cookies.find(c =>
              c.name === '__Secure-next-auth.session-token' ||
              c.name === '__Host-next-auth.csrf-token'
            );

            if (sessionCookie || cookies.length > 0) {
              this.sessionCookies = cookies;
              this.sessionToken = sessionCookie ? sessionCookie.value : null;

              // Initialize usage tracking
              this.initializeUsageTracking();

              // Save session
              this.saveSession();

              // Close window
              setTimeout(() => {
                if (this.authWindow && !this.authWindow.isDestroyed()) {
                  this.authWindow.close();
                }
              }, 1000);

              this.emit('authenticated');
              resolve(true);
            }
          } catch (error) {
            console.error('Failed to capture session:', error);
            reject(error);
          }
        }
      });

      this.authWindow.on('closed', () => {
        this.authWindow = null;
        if (!this.sessionCookies) {
          reject(new Error('Login cancelled'));
        }
      });
    });
  }

  // Initialize usage tracking
  initializeUsageTracking() {
    const now = new Date();

    // Check if we need to reset usage (3-hour window for GPT-4)
    if (this.resetTime && now >= this.resetTime) {
      this.currentUsage = 0;
      this.usageHistory = [];
    }

    // Set next reset time (3 hours from now)
    if (!this.resetTime || now >= this.resetTime) {
      this.resetTime = new Date(now.getTime() + 3 * 60 * 60 * 1000);
    }

    console.log('Usage tracking initialized');
    console.log(`Current usage: ${this.currentUsage}/${this.usageLimit}`);
    console.log(`Reset time: ${this.resetTime.toLocaleString()}`);
  }

  // Track a message sent to ChatGPT
  trackMessage(messageType = 'gpt-4') {
    const now = new Date();

    // Check if we need to reset
    if (now >= this.resetTime) {
      this.currentUsage = 0;
      this.usageHistory = [];
      this.resetTime = new Date(now.getTime() + 3 * 60 * 60 * 1000);
    }

    // Increment usage
    this.currentUsage++;

    // Add to history
    this.usageHistory.push({
      timestamp: now.toISOString(),
      type: messageType
    });

    // Keep only last 3 hours of history
    const threeHoursAgo = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    this.usageHistory = this.usageHistory.filter(h =>
      new Date(h.timestamp) > threeHoursAgo
    );

    // Save updated usage
    this.saveSession();

    // Emit usage update
    this.emit('usage-updated', this.getUsageData());

    console.log(`Tracked message: ${this.currentUsage}/${this.usageLimit}`);
  }

  // Get current usage data
  getUsageData() {
    const percentage = Math.round((this.currentUsage / this.usageLimit) * 100);
    const now = new Date();
    const resetIn = this.resetTime ? this.resetTime - now : 0;

    return {
      used: this.currentUsage,
      limit: this.usageLimit,
      percentage: percentage,
      resetAt: this.resetTime ? this.resetTime.toISOString() : null,
      resetIn: Math.max(0, Math.floor(resetIn / 1000)), // seconds
      subscription: 'ChatGPT Plus',
      type: '3-hour',
      model: 'GPT-4',
      realData: false, // This is tracked locally
      source: 'local-tracking'
    };
  }

  // Capture existing browser session (if ChatGPT is open)
  async captureSessionFromBrowser() {
    try {
      // Try to find an existing ChatGPT session in the default browser
      // This is a simplified approach - in practice, you'd need browser-specific logic
      console.log('Attempting to capture existing ChatGPT session...');

      // For now, return false to require manual login
      return false;
    } catch (error) {
      console.error('Failed to capture browser session:', error);
      return false;
    }
  }

  // Simulate usage for demo/testing
  simulateUsage() {
    // Simulate some usage throughout the 3-hour window
    const now = new Date();
    const windowStart = new Date(now.getTime() - Math.random() * 2 * 60 * 60 * 1000);

    // Random usage between 0-50% of limit
    this.currentUsage = Math.floor(Math.random() * this.usageLimit * 0.5);

    // Set reset time
    this.resetTime = new Date(windowStart.getTime() + 3 * 60 * 60 * 1000);

    // Make sure reset is in the future
    if (this.resetTime <= now) {
      this.resetTime = new Date(now.getTime() + Math.random() * 3 * 60 * 60 * 1000);
    }

    this.saveSession();
    return this.getUsageData();
  }

  // Check if we have a valid session
  hasValidSession() {
    return this.sessionCookies && this.sessionCookies.length > 0;
  }

  // Clear session
  logout() {
    this.sessionCookies = null;
    this.sessionToken = null;
    this.currentUsage = 0;
    this.resetTime = null;
    this.usageHistory = [];

    // Delete saved session file
    try {
      if (fs.existsSync(this.cookieFile)) {
        fs.unlinkSync(this.cookieFile);
      }
    } catch (error) {
      console.error('Failed to delete session file:', error);
    }

    this.emit('logged-out');
  }

  // Monitor ChatGPT activity (can be called periodically)
  async checkActivity() {
    // This would integrate with a proxy or browser extension
    // to detect actual ChatGPT API calls
    // For now, it's a placeholder for future implementation
    console.log('Checking ChatGPT activity...');

    // Return current usage
    return this.getUsageData();
  }
}

module.exports = OpenAISubscriptionAuth;