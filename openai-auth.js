const EventEmitter = require('events');
const { BrowserWindow, session } = require('electron');
const crypto = require('crypto');
const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const os = require('os');

class OpenAIAuth extends EventEmitter {
  constructor() {
    super();
    this.authWindow = null;
    this.authServer = null;
    this.accessToken = null;
    this.refreshToken = null;
    this.apiKey = null; // For API key authentication
    this.tokenFile = path.join(os.homedir(), '.alldaypoke', 'openai-token.json');

    // OpenAI OAuth configuration
    // Note: You'll need to register your app at https://platform.openai.com/settings/oauth
    this.clientId = process.env.OPENAI_CLIENT_ID || 'your-client-id';
    this.clientSecret = process.env.OPENAI_CLIENT_SECRET || 'your-client-secret';
    this.redirectUri = 'http://localhost:8765/callback';
    this.authorizationBaseUrl = 'https://auth.openai.com/authorize';
    this.tokenUrl = 'https://auth.openai.com/oauth/token';

    // Load saved token or API key if exists
    this.loadSavedToken();
  }

  // Load saved token from file
  loadSavedToken() {
    try {
      if (fs.existsSync(this.tokenFile)) {
        const data = JSON.parse(fs.readFileSync(this.tokenFile, 'utf8'));
        if (data.apiKey) {
          this.apiKey = data.apiKey;
          console.log('Loaded saved OpenAI API key');
        } else {
          this.accessToken = data.accessToken;
          this.refreshToken = data.refreshToken;
          this.tokenExpiry = data.tokenExpiry ? new Date(data.tokenExpiry) : null;
          console.log('Loaded saved OpenAI OAuth token');
        }
        return true;
      }
    } catch (error) {
      console.error('Failed to load saved token:', error);
    }
    return false;
  }

  // Save token to file
  saveToken(accessToken, refreshToken, expiresIn) {
    try {
      const dir = path.dirname(this.tokenFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const tokenExpiry = expiresIn ?
        new Date(Date.now() + (expiresIn * 1000)).toISOString() :
        null;

      const data = {
        accessToken,
        refreshToken,
        tokenExpiry,
        savedAt: new Date().toISOString()
      };

      fs.writeFileSync(this.tokenFile, JSON.stringify(data, null, 2));
      console.log('Saved OpenAI token');
    } catch (error) {
      console.error('Failed to save token:', error);
    }
  }

  // Save API key to file
  saveApiKey(apiKey) {
    try {
      const dir = path.dirname(this.tokenFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const data = {
        apiKey,
        savedAt: new Date().toISOString()
      };

      fs.writeFileSync(this.tokenFile, JSON.stringify(data, null, 2));
      this.apiKey = apiKey;
      console.log('Saved OpenAI API key');
    } catch (error) {
      console.error('Failed to save API key:', error);
    }
  }

  // Generate PKCE challenge
  generatePKCE() {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto
      .createHash('sha256')
      .update(verifier)
      .digest('base64url');
    return { verifier, challenge };
  }

  // Start OAuth flow
  async startOAuthFlow() {
    return new Promise((resolve, reject) => {
      // Generate PKCE
      const { verifier, challenge } = this.generatePKCE();
      const state = crypto.randomBytes(16).toString('hex');

      // Create local server to handle callback
      this.authServer = http.createServer(async (req, res) => {
        const queryObject = url.parse(req.url, true).query;

        if (queryObject.code) {
          // Exchange code for token
          try {
            const tokens = await this.exchangeCodeForToken(
              queryObject.code,
              verifier
            );

            this.accessToken = tokens.access_token;
            this.refreshToken = tokens.refresh_token;
            this.saveToken(
              tokens.access_token,
              tokens.refresh_token,
              tokens.expires_in
            );

            // Success response
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`
              <!DOCTYPE html>
              <html>
              <head>
                <style>
                  body {
                    font-family: system-ui, -apple-system, sans-serif;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    height: 100vh;
                    margin: 0;
                    background: linear-gradient(135deg, #10a37f 0%, #147960 100%);
                    color: white;
                  }
                  .container {
                    text-align: center;
                    padding: 40px;
                    background: rgba(255, 255, 255, 0.1);
                    border-radius: 20px;
                    backdrop-filter: blur(10px);
                  }
                  h1 { font-size: 48px; margin-bottom: 20px; }
                  p { font-size: 20px; opacity: 0.9; }
                </style>
              </head>
              <body>
                <div class="container">
                  <h1>✅ Success!</h1>
                  <p>Authentication complete. You can close this window.</p>
                </div>
              </body>
              </html>
            `);

            // Clean up
            this.authServer.close();
            if (this.authWindow && !this.authWindow.isDestroyed()) {
              this.authWindow.close();
            }

            this.emit('authenticated', tokens);
            resolve(true);
          } catch (error) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Authentication failed: ' + error.message);
            reject(error);
          }
        } else {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('No authorization code received');
        }
      });

      this.authServer.listen(8765, () => {
        console.log('OAuth callback server listening on port 8765');

        // Build authorization URL
        const authUrl = new URL(this.authorizationBaseUrl);
        authUrl.searchParams.append('client_id', this.clientId);
        authUrl.searchParams.append('response_type', 'code');
        authUrl.searchParams.append('redirect_uri', this.redirectUri);
        authUrl.searchParams.append('scope', 'model.read model.request');
        authUrl.searchParams.append('state', state);
        authUrl.searchParams.append('code_challenge', challenge);
        authUrl.searchParams.append('code_challenge_method', 'S256');

        // Open browser window
        this.authWindow = new BrowserWindow({
          width: 600,
          height: 700,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
          },
          title: 'OpenAI Login'
        });

        this.authWindow.loadURL(authUrl.toString());

        this.authWindow.on('closed', () => {
          this.authWindow = null;
          if (this.authServer) {
            this.authServer.close();
            this.authServer = null;
          }
        });
      });
    });
  }

  // Exchange authorization code for token
  async exchangeCodeForToken(code, verifier) {
    const fetch = require('electron').net.fetch;

    const params = new URLSearchParams();
    params.append('grant_type', 'authorization_code');
    params.append('code', code);
    params.append('client_id', this.clientId);
    params.append('client_secret', this.clientSecret);
    params.append('redirect_uri', this.redirectUri);
    params.append('code_verifier', verifier);

    const response = await fetch(this.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: params.toString()
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token exchange failed: ${error}`);
    }

    return await response.json();
  }

  // Refresh access token
  async refreshAccessToken() {
    if (!this.refreshToken) {
      throw new Error('No refresh token available');
    }

    const fetch = require('electron').net.fetch;

    const params = new URLSearchParams();
    params.append('grant_type', 'refresh_token');
    params.append('refresh_token', this.refreshToken);
    params.append('client_id', this.clientId);
    params.append('client_secret', this.clientSecret);

    const response = await fetch(this.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: params.toString()
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token refresh failed: ${error}`);
    }

    const tokens = await response.json();
    this.accessToken = tokens.access_token;
    if (tokens.refresh_token) {
      this.refreshToken = tokens.refresh_token;
    }

    this.saveToken(
      this.accessToken,
      this.refreshToken,
      tokens.expires_in
    );

    return tokens;
  }

  // Check if token needs refresh
  isTokenExpired() {
    if (!this.tokenExpiry) return false;
    return new Date() >= new Date(this.tokenExpiry);
  }

  // Get valid access token (refresh if needed)
  async getValidToken() {
    if (!this.accessToken) {
      throw new Error('Not authenticated');
    }

    if (this.isTokenExpired() && this.refreshToken) {
      await this.refreshAccessToken();
    }

    return this.accessToken;
  }

  // Fetch usage from OpenAI API
  async fetchUsage() {
    const fetch = require('electron').net.fetch;

    // Get current billing cycle dates
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);

    try {
      let authHeader;

      if (this.apiKey) {
        authHeader = `Bearer ${this.apiKey}`;
      } else if (this.accessToken) {
        const token = await this.getValidToken();
        authHeader = `Bearer ${token}`;
      } else {
        throw new Error('No authentication available');
      }

      // For API keys, try to fetch usage (may require billing permissions)
      // Most API keys won't have access to billing endpoints
      if (this.apiKey) {
        try {
          // Try to fetch usage with API key
          const response = await fetch('https://api.openai.com/v1/usage', {
            method: 'GET',
            headers: {
              'Authorization': authHeader,
              'Accept': 'application/json'
            }
          });

          if (response.ok) {
            const data = await response.json();

            // Process usage data if available
            const limit = 120; // Default $120 for Plus
            const used = data.total_usage ? data.total_usage / 100 : 0;
            const percentage = Math.min(100, Math.round((used / limit) * 100));

            return {
              used: used,
              limit: limit,
              percentage: percentage,
              resetAt: endOfMonth.toISOString(),
              subscription: 'OpenAI Plus',
              type: 'monthly',
              realData: true,
              source: 'openai-api'
            };
          }
        } catch (apiError) {
          console.log('Cannot fetch usage with API key - using simulated tracking');
          // Fall through to simulated tracking
        }

        // Simulated usage for API keys without billing access
        const simulatedUsage = this.getSimulatedUsage();
        return simulatedUsage;
      }

      // OAuth token - try full billing API
      const response = await fetch('https://api.openai.com/v1/dashboard/billing/usage', {
        method: 'GET',
        headers: {
          'Authorization': authHeader,
          'Accept': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`API request failed: ${response.status}`);
      }

      const data = await response.json();

      // Also fetch subscription info
      const subResponse = await fetch('https://api.openai.com/v1/dashboard/billing/subscription', {
        method: 'GET',
        headers: {
          'Authorization': authHeader,
          'Accept': 'application/json'
        }
      });

      let subscription = {};
      if (subResponse.ok) {
        subscription = await subResponse.json();
      }

      // Calculate usage percentage
      const limit = subscription.hard_limit_usd || 120; // Default $120 for Plus
      const used = data.total_usage / 100; // Convert cents to dollars
      const percentage = Math.min(100, Math.round((used / limit) * 100));

      return {
        used: used,
        limit: limit,
        percentage: percentage,
        resetAt: endOfMonth.toISOString(),
        subscription: subscription.plan?.title || 'OpenAI Plus',
        type: 'monthly',
        realData: true,
        source: 'openai-api'
      };
    } catch (error) {
      console.error('Failed to fetch OpenAI usage:', error);
      // Return simulated usage as fallback
      return this.getSimulatedUsage();
    }
  }

  // Get simulated usage (for demo or when API is unavailable)
  getSimulatedUsage() {
    const now = new Date();
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const dayOfMonth = now.getDate();
    const daysInMonth = endOfMonth.getDate();

    // Simulate gradual usage increase throughout the month
    const baseUsage = Math.round((dayOfMonth / daysInMonth) * 40); // Base 40% by end of month
    const variation = Math.random() * 10; // Add some variation
    const percentage = Math.min(100, Math.round(baseUsage + variation));

    return {
      used: percentage,
      limit: 100,
      percentage: percentage,
      resetAt: endOfMonth.toISOString(),
      subscription: 'OpenAI Plus',
      type: 'monthly',
      realData: false,
      source: 'simulated'
    };
  }

  // Logout
  logout() {
    this.accessToken = null;
    this.refreshToken = null;
    this.tokenExpiry = null;

    // Delete saved token file
    try {
      if (fs.existsSync(this.tokenFile)) {
        fs.unlinkSync(this.tokenFile);
      }
    } catch (error) {
      console.error('Failed to delete token file:', error);
    }

    this.emit('logged-out');
  }
}

module.exports = OpenAIAuth;