const https = require('https');
const crypto = require('crypto');
const { shell, BrowserWindow, dialog } = require('electron');
const EventEmitter = require('events');
const log = require('./logger');

class AuthManager extends EventEmitter {
  constructor() {
    super();
    this.accessToken = null;
    this.refreshToken = null;
    this.apiKey = null;
    this.tokenExpiry = null;
    this.authMethod = 'api-key'; // 'oauth' or 'api-key'

    // OAuth configuration for Anthropic/Claude
    // Note: These are example endpoints - actual Anthropic OAuth may differ
    this.oauthConfig = {
      clientId: process.env.ANTHROPIC_CLIENT_ID || 'alldaypoke',
      redirectUri: 'http://localhost:8989/callback',
      authorizationUrl: 'https://console.anthropic.com/oauth/authorize', // Try console.anthropic.com
      tokenUrl: 'https://api.anthropic.com/v1/oauth/token',
      scope: 'read:usage read:limits'
    };
  }

  // Initialize authentication based on available credentials
  async initialize() {
    // Check for existing API key
    if (process.env.ANTHROPIC_API_KEY) {
      this.apiKey = process.env.ANTHROPIC_API_KEY;
      this.authMethod = 'api-key';
      this.emit('authenticated', { method: 'api-key' });
      return true;
    }

    // Check for stored OAuth tokens
    const storedTokens = this.loadStoredTokens();
    if (storedTokens && storedTokens.accessToken) {
      this.accessToken = storedTokens.accessToken;
      this.refreshToken = storedTokens.refreshToken;
      this.tokenExpiry = storedTokens.tokenExpiry;
      this.authMethod = 'oauth';

      // Check if token needs refresh
      if (this.isTokenExpired()) {
        await this.refreshAccessToken();
      }

      this.emit('authenticated', { method: 'oauth' });
      return true;
    }

    return false;
  }

  // Start OAuth 2.0 with PKCE flow
  async startOAuthFlow() {
    // Generate PKCE challenge
    const codeVerifier = this.generateCodeVerifier();
    const codeChallenge = this.generateCodeChallenge(codeVerifier);

    // Generate state parameter for CSRF protection
    const state = crypto.randomBytes(32).toString('base64url');

    // Build authorization URL
    const authUrl = new URL(this.oauthConfig.authorizationUrl);
    authUrl.searchParams.append('client_id', this.oauthConfig.clientId);
    authUrl.searchParams.append('redirect_uri', this.oauthConfig.redirectUri);
    authUrl.searchParams.append('response_type', 'code');
    authUrl.searchParams.append('scope', this.oauthConfig.scope);
    authUrl.searchParams.append('state', state);
    authUrl.searchParams.append('code_challenge', codeChallenge);
    authUrl.searchParams.append('code_challenge_method', 'S256');

    // Open OAuth URL in default browser
    shell.openExternal(authUrl.toString());

    // Show dialog to inform user
    const waitingDialog = new BrowserWindow({
      width: 400,
      height: 200,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    });

    waitingDialog.loadURL(`data:text/html,
      <html>
        <body style="background: rgba(26,26,26,0.95); color: #fff; font-family: monospace; padding: 20px; border-radius: 8px; text-align: center;">
          <h3 style="color: #cd7f5d;">Waiting for authentication...</h3>
          <p>Please complete the login in your browser.</p>
          <p style="color: #888; font-size: 11px;">This window will close automatically when done.</p>
        </body>
      </html>
    `);

    // Set up local server to receive callback
    const authCode = await this.waitForCallback(waitingDialog, state);

    if (authCode) {
      // Exchange code for token
      const tokens = await this.exchangeCodeForToken(authCode, codeVerifier);
      if (tokens) {
        this.accessToken = tokens.access_token;
        this.refreshToken = tokens.refresh_token;
        this.tokenExpiry = Date.now() + (tokens.expires_in * 1000);
        this.authMethod = 'oauth';

        this.saveTokens();
        this.emit('authenticated', { method: 'oauth' });
        return true;
      }
    }

    return false;
  }

  // Generate PKCE code verifier
  generateCodeVerifier() {
    return crypto.randomBytes(32).toString('base64url');
  }

  // Generate PKCE code challenge
  generateCodeChallenge(verifier) {
    return crypto.createHash('sha256')
      .update(verifier)
      .digest('base64url');
  }

  // Wait for OAuth callback
  async waitForCallback(waitingDialog, expectedState) {
    return new Promise((resolve) => {
      const http = require('http');
      const server = http.createServer((req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`);

        if (url.pathname === '/callback') {
          const code = url.searchParams.get('code');
          const error = url.searchParams.get('error');
          const returnedState = url.searchParams.get('state');

          // Verify state parameter for CSRF protection
          if (!error && returnedState !== expectedState) {
            error = 'state_mismatch';
          }

          // Send a nice HTML response to the browser
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <!DOCTYPE html>
            <html>
            <head>
              <title>All Day Poke - Authentication</title>
              <style>
                body {
                  background: #1a1a1a;
                  color: #fff;
                  font-family: 'Monaco', 'Menlo', monospace;
                  display: flex;
                  justify-content: center;
                  align-items: center;
                  height: 100vh;
                  margin: 0;
                }
                .container {
                  text-align: center;
                  padding: 40px;
                }
                h1 {
                  color: #cd7f5d;
                  font-size: 28px;
                  margin-bottom: 20px;
                }
                .robot {
                  font-size: 48px;
                  margin: 20px 0;
                }
                p {
                  color: #888;
                  margin: 10px 0;
                }
                .success {
                  color: #39ff14;
                }
                .error {
                  color: #ff3333;
                }
              </style>
            </head>
            <body>
              <div class="container">
                <div class="robot">🤖</div>
                ${error ?
                  `<h1 class="error">Authentication Failed</h1>
                   <p>Error: ${error}</p>
                   <p>Please try again or use an API key instead.</p>` :
                  `<h1 class="success">Authentication Successful!</h1>
                   <p>All Day Poke is now connected to your Claude account.</p>
                   <p>You can close this browser tab.</p>`
                }
              </div>
            </body>
            </html>
          `);

          server.close();
          if (waitingDialog && !waitingDialog.isDestroyed()) {
            waitingDialog.close();
          }
          resolve(code);
        }
      });

      server.listen(8989, 'localhost', () => {
        log('OAuth callback server listening on http://localhost:8989/callback');
      });

      // Handle waiting dialog close (user cancelled)
      if (waitingDialog) {
        waitingDialog.on('closed', () => {
          server.close();
          resolve(null);
        });
      }

      // Timeout after 5 minutes
      setTimeout(() => {
        server.close();
        if (waitingDialog && !waitingDialog.isDestroyed()) {
          waitingDialog.close();
        }
        resolve(null);
      }, 5 * 60 * 1000);
    });
  }

  // Exchange authorization code for tokens
  async exchangeCodeForToken(code, codeVerifier) {
    return new Promise((resolve, reject) => {
      const data = new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        client_id: this.oauthConfig.clientId,
        redirect_uri: this.oauthConfig.redirectUri,
        code_verifier: codeVerifier
      }).toString();

      const options = {
        hostname: new URL(this.oauthConfig.tokenUrl).hostname,
        path: new URL(this.oauthConfig.tokenUrl).pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': data.length
        }
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const tokens = JSON.parse(body);
            resolve(tokens);
          } catch (error) {
            reject(error);
          }
        });
      });

      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  // Refresh OAuth access token
  async refreshAccessToken() {
    if (!this.refreshToken) {
      throw new Error('No refresh token available');
    }

    return new Promise((resolve, reject) => {
      const data = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken,
        client_id: this.oauthConfig.clientId
      }).toString();

      const options = {
        hostname: new URL(this.oauthConfig.tokenUrl).hostname,
        path: new URL(this.oauthConfig.tokenUrl).pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': data.length
        }
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const tokens = JSON.parse(body);
            this.accessToken = tokens.access_token;
            if (tokens.refresh_token) {
              this.refreshToken = tokens.refresh_token;
            }
            this.tokenExpiry = Date.now() + (tokens.expires_in * 1000);
            this.saveTokens();
            resolve(tokens);
          } catch (error) {
            reject(error);
          }
        });
      });

      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  // Get current authentication headers
  getAuthHeaders() {
    if (this.authMethod === 'oauth' && this.accessToken) {
      // Check if token needs refresh
      if (this.isTokenExpired()) {
        this.refreshAccessToken().catch(log.error);
      }
      return {
        'Authorization': `Bearer ${this.accessToken}`,
        'anthropic-version': '2023-06-01'
      };
    } else if (this.apiKey) {
      return {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01'
      };
    }

    throw new Error('No authentication available');
  }

  // Check if OAuth token is expired
  isTokenExpired() {
    if (!this.tokenExpiry) return true;
    return Date.now() >= this.tokenExpiry - 60000; // Refresh 1 minute before expiry
  }

  // Save OAuth tokens to secure storage
  saveTokens() {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');

    const configDir = path.join(os.homedir(), '.alldaypoke');
    const tokenFile = path.join(configDir, '.tokens');

    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    const data = {
      accessToken: this.accessToken,
      refreshToken: this.refreshToken,
      tokenExpiry: this.tokenExpiry
    };

    // Simple encryption (in production, use proper encryption)
    const encrypted = Buffer.from(JSON.stringify(data)).toString('base64');
    fs.writeFileSync(tokenFile, encrypted, { mode: 0o600 });
  }

  // Load stored OAuth tokens
  loadStoredTokens() {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');

    const tokenFile = path.join(os.homedir(), '.alldaypoke', '.tokens');

    if (fs.existsSync(tokenFile)) {
      try {
        const encrypted = fs.readFileSync(tokenFile, 'utf8');
        const decrypted = Buffer.from(encrypted, 'base64').toString('utf8');
        return JSON.parse(decrypted);
      } catch (error) {
        log.error('Failed to load stored tokens:', error);
      }
    }

    return null;
  }

  // Clear stored authentication
  clearAuth() {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');

    const tokenFile = path.join(os.homedir(), '.alldaypoke', '.tokens');

    if (fs.existsSync(tokenFile)) {
      fs.unlinkSync(tokenFile);
    }

    this.accessToken = null;
    this.refreshToken = null;
    this.apiKey = null;
    this.tokenExpiry = null;

    this.emit('logout');
  }
}

module.exports = AuthManager;