const { BrowserWindow, session, shell, dialog } = require('electron');
const EventEmitter = require('events');
const https = require('https');
const http = require('http');
const url = require('url');

class ClaudeAuth extends EventEmitter {
  constructor() {
    super();
    this.sessionToken = null;
    this.organizationId = null;
    this.userId = null;
    this.subscription = null;
    this.cookies = null;
    this.callbackServer = null;
    this.oauthToken = null; // Claude OAuth token from setup-token
  }

  // Start Claude.ai login flow using default browser
  async startLoginFlow() {
    return new Promise(async (resolve, reject) => {
      // First, try to capture existing session
      console.log('Checking for existing Claude session...');

      try {
        const hasExistingSession = await this.captureSessionFromBrowser();

        if (hasExistingSession && this.cookies && this.cookies.length > 0) {
          console.log('Found existing Claude session!');

          // Show success dialog
          dialog.showMessageBox({
            type: 'info',
            title: 'Already Logged In',
            message: 'You are already logged into Claude!',
            detail: 'OpenClaw Pet has connected to your existing Claude session. The app will now start tracking your usage.',
            buttons: ['Great!']
          });

          resolve(true);
          return;
        }
      } catch (error) {
        console.log('No existing session found, proceeding with login flow...');
      }

      // If no existing session, proceed with login flow
      // Create a local HTTP server to handle the callback
      const port = 43875; // Random high port
      const callbackUrl = `http://localhost:${port}/auth/callback`;

      // Create callback server
      this.callbackServer = http.createServer(async (req, res) => {
        const parsedUrl = url.parse(req.url, true);

        if (parsedUrl.pathname === '/auth/callback' || parsedUrl.pathname === '/auth/complete') {
          // Send success HTML page
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <!DOCTYPE html>
            <html>
            <head>
              <title>Authentication Successful</title>
              <style>
                body {
                  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                  color: white;
                  display: flex;
                  justify-content: center;
                  align-items: center;
                  height: 100vh;
                  margin: 0;
                }
                .container {
                  text-align: center;
                  background: rgba(255, 255, 255, 0.1);
                  padding: 3rem;
                  border-radius: 1rem;
                  backdrop-filter: blur(10px);
                }
                h1 {
                  margin: 0 0 1rem 0;
                  font-size: 2rem;
                }
                p {
                  margin: 0.5rem 0;
                  opacity: 0.9;
                }
                .check {
                  font-size: 4rem;
                  margin-bottom: 1rem;
                }
              </style>
            </head>
            <body>
              <div class="container">
                <div class="check">✅</div>
                <h1>Successfully Connected!</h1>
                <p>OpenClaw Pet is now connected to your Claude account.</p>
                <p>You can close this window and return to the application.</p>
                <script>
                  // Auto-close after 3 seconds
                  setTimeout(() => {
                    window.close();
                  }, 3000);
                </script>
              </div>
            </body>
            </html>
          `);

          // Capture the session
          await this.captureSessionFromBrowser();

          // Close the server
          if (this.callbackServer) {
            this.callbackServer.close();
            this.callbackServer = null;
          }

          // Resolve the promise
          if (this.sessionToken || this.cookies) {
            resolve(true);
          } else {
            reject(new Error('Failed to capture session'));
          }
        } else {
          // Handle other requests
          res.writeHead(404);
          res.end('Not found');
        }
      });

      // Start listening
      this.callbackServer.listen(port, () => {
        console.log(`OAuth callback server listening on port ${port}`);

        // Open Claude in default browser
        const loginUrl = 'https://claude.ai/chat';
        shell.openExternal(loginUrl);

        // Show instruction dialog with manual completion option
        dialog.showMessageBox({
          type: 'info',
          title: 'Authenticate with Claude',
          message: 'Your browser has been opened to Claude.',
          detail: 'If you are already logged in, simply return here and click "I\'m Logged In". Otherwise, please log in first.\n\nOnce you\'re logged in, visit:\nhttp://localhost:43875/auth/complete',
          buttons: ['I\'m Logged In', 'Cancel']
        }).then(async (result) => {
          if (result.response === 0) {
            // User clicked "I'm Logged In"
            // Capture the session
            await this.captureSessionFromBrowser();

            // Close the server
            if (this.callbackServer) {
              this.callbackServer.close();
              this.callbackServer = null;
            }

            // Resolve the promise
            if (this.sessionToken || this.cookies) {
              resolve(true);
            } else {
              reject(new Error('Failed to capture session'));
            }
          } else {
            // User clicked Cancel
            if (this.callbackServer) {
              this.callbackServer.close();
              this.callbackServer = null;
            }
            reject(new Error('Authentication cancelled'));
          }
        });
      });

      // Set timeout for the server
      setTimeout(() => {
        if (this.callbackServer) {
          this.callbackServer.close();
          this.callbackServer = null;
          reject(new Error('Authentication timeout'));
        }
      }, 120000); // 2 minute timeout
    });
  }

  // Try to fetch usage from API endpoints
  async fetchFromAPI() {
    return new Promise((resolve, reject) => {
      // If we have an OAuth token from claude setup-token, use it directly
      if (this.oauthToken) {
        console.log('Using Claude OAuth token for API request');

        const options = {
          hostname: 'claude.ai',
          port: 443,
          path: '/api/oauth/usage',
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${this.oauthToken}`,
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            'Accept': 'application/json, text/plain, */*',
            'Origin': 'https://claude.ai',
            'Referer': 'https://claude.ai/chat'
          }
        };

        const req = https.request(options, (res) => {
          let data = '';

          res.on('data', (chunk) => {
            data += chunk;
          });

          res.on('end', () => {
            if (res.statusCode === 200 || res.statusCode === 201) {
              try {
                const parsed = JSON.parse(data);
                console.log('OAuth API response:', parsed);

                // Parse the OAuth usage response
                let usage = {
                  used: 0,
                  limit: 0,
                  subscription: 'Unknown',
                  realData: true,
                  source: 'Claude OAuth Token'
                };

                // OAuth endpoint returns utilization percentages
                if (parsed.five_hour) {
                  usage.used = Math.round(parsed.five_hour.utilization || 0);
                  usage.limit = 100; // Utilization is a percentage
                  usage.percentage = usage.used;
                  usage.resetAt = parsed.five_hour.resets_at;
                  usage.type = 'five_hour';
                }

                // Track 7-day limit as well
                if (parsed.seven_day) {
                  usage.weeklyUsed = Math.round(parsed.seven_day.utilization || 0);
                  usage.weeklyLimit = 100;
                  usage.weeklyResetAt = parsed.seven_day.resets_at;
                }

                // Detect subscription type
                if (parsed.seven_day_opus) {
                  usage.opusUsed = Math.round(parsed.seven_day_opus.utilization || 0);
                  usage.subscription = 'Claude Max';
                } else {
                  usage.subscription = 'Claude Pro';
                }

                console.log('Successfully fetched real usage with Claude token:', usage);
                resolve(usage);
              } catch (error) {
                console.error('Failed to parse OAuth response:', error, 'Data:', data);
                reject(new Error(`Failed to parse response: ${error.message}`));
              }
            } else {
              console.log(`OAuth endpoint returned ${res.statusCode}: ${data}`);
              reject(new Error(`API returned ${res.statusCode}`));
            }
          });
        });

        req.on('error', (error) => {
          console.error('OAuth request failed:', error);
          reject(error);
        });

        req.end();
        return; // Exit early when using OAuth token
      }

      // Fallback to cookie-based auth if no OAuth token
      if (!this.cookies || this.cookies.length === 0) {
        reject(new Error('No authentication available'));
        return;
      }

      const cookieString = this.cookies
        .map(c => `${c.name}=${c.value}`)
        .join('; ');

      // Try different possible API endpoints
      const endpoints = [
        '/api/oauth/usage',  // Real OAuth usage endpoint!
        '/v1/oauth/usage',
        '/api/account',
        '/api/user',
        '/api/subscription',
        '/api/organizations/current',
        '/api/limits',
        '/api/usage/current',
        '/api/me'
      ];

      let currentIndex = 0;

      const tryNext = () => {
        if (currentIndex >= endpoints.length) {
          reject(new Error('No working API endpoint found'));
          return;
        }

        const endpoint = endpoints[currentIndex++];
        console.log(`Trying API endpoint: ${endpoint}`);

        // Try to extract Bearer token from cookies or session
        let bearerToken = null;
        const tokenCookie = this.cookies.find(c =>
          c.name === 'access_token' ||
          c.name === 'bearer_token' ||
          c.name === 'auth_token'
        );
        if (tokenCookie) {
          bearerToken = tokenCookie.value;
        }

        const headers = {
          'Cookie': cookieString,
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Referer': 'https://claude.ai/chat',
          'Origin': 'https://claude.ai',
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin'
        };

        // Add Bearer auth for OAuth endpoint
        if (endpoint.includes('oauth') && bearerToken) {
          headers['Authorization'] = `Bearer ${bearerToken}`;
        } else if (endpoint.includes('oauth') && this.sessionToken) {
          headers['Authorization'] = `Bearer ${this.sessionToken}`;
        }

        const options = {
          hostname: 'claude.ai',
          port: 443,
          path: endpoint,
          method: 'GET',
          headers: headers
        };

        const req = https.request(options, (res) => {
          let data = '';

          res.on('data', (chunk) => {
            data += chunk;
          });

          res.on('end', () => {
            if (res.statusCode === 200 || res.statusCode === 201) {
              try {
                const parsed = JSON.parse(data);
                console.log(`API ${endpoint} response:`, parsed);

                // Try to extract usage from various response structures
                let usage = { used: 0, limit: 0, subscription: 'Unknown' };

                // Check for OAuth usage endpoint format (real usage data!)
                if (parsed.five_hour || parsed.seven_day) {
                  console.log('Found OAuth usage data!');

                  // Use 5-hour limit as primary (more frequently reset)
                  if (parsed.five_hour) {
                    usage.used = Math.round(parsed.five_hour.utilization || 0);
                    usage.limit = 100; // Utilization is percentage
                    usage.resetAt = parsed.five_hour.resets_at;
                    usage.type = 'five_hour';
                  }

                  // Also track 7-day limit
                  if (parsed.seven_day) {
                    usage.weeklyUsed = Math.round(parsed.seven_day.utilization || 0);
                    usage.weeklyLimit = 100;
                    usage.weeklyResetAt = parsed.seven_day.resets_at;
                  }

                  // Check for Opus usage (Max users)
                  if (parsed.seven_day_opus) {
                    usage.opusUsed = Math.round(parsed.seven_day_opus.utilization || 0);
                    usage.subscription = 'Claude Max';
                  } else {
                    usage.subscription = 'Claude Pro';
                  }

                  // OAuth endpoint found - this is real data!
                  usage.realData = true;
                }

                // Check for direct usage fields
                else if (parsed.usage) {
                  usage.used = parsed.usage.used || parsed.usage.current || 0;
                  usage.limit = parsed.usage.limit || parsed.usage.max || 0;
                }

                // Check for message limits
                else if (parsed.message_limit || parsed.messageLimit) {
                  const msgLimit = parsed.message_limit || parsed.messageLimit;
                  usage.limit = msgLimit.limit || msgLimit.max || usage.limit;
                  usage.used = msgLimit.used || msgLimit.current || usage.used;
                }

                // Check for subscription info
                else if (parsed.subscription) {
                  usage.subscription = parsed.subscription.plan || parsed.subscription.type || 'Claude';
                  if (parsed.subscription.usage) {
                    usage.used = parsed.subscription.usage.current || usage.used;
                    usage.limit = parsed.subscription.usage.limit || usage.limit;
                  }
                }

                // Check for plan info
                else if (parsed.plan) {
                  usage.subscription = `Claude ${parsed.plan.name || parsed.plan}`;
                }

                // Check for limits in various formats
                else if (parsed.limits) {
                  if (parsed.limits.messages) {
                    usage.limit = parsed.limits.messages.daily || parsed.limits.messages.total || usage.limit;
                  }
                }

                // Check for current usage
                else if (parsed.current_usage) {
                  usage.used = parsed.current_usage.messages || parsed.current_usage.count || usage.used;
                }

                // If we found any real data, use it
                if (usage.realData || usage.used > 0 || usage.limit > 0 || usage.subscription !== 'Unknown') {
                  usage.percentage = usage.used; // For OAuth, used is already the percentage
                  if (!usage.resetAt) {
                    usage.resetAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
                  }
                  usage.source = `API: ${endpoint}`;
                  resolve(usage);
                } else {
                  // Try next endpoint
                  tryNext();
                }
              } catch (error) {
                console.log(`Failed to parse API response from ${endpoint}:`, error.message);
                tryNext();
              }
            } else {
              console.log(`API ${endpoint} returned status ${res.statusCode}`);
              tryNext();
            }
          });
        });

        req.on('error', (error) => {
          console.log(`API request to ${endpoint} failed:`, error.message);
          tryNext();
        });

        req.end();
      };

      tryNext();
    });
  }

  // Capture session from browser using a hidden window
  async captureSessionFromBrowser() {
    return new Promise((resolve) => {
      // Create a hidden window to capture the session
      const hiddenWindow = new BrowserWindow({
        width: 1,
        height: 1,
        show: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          partition: 'persist:claude-auth'
        }
      });

      // Load Claude.ai to capture existing session
      hiddenWindow.loadURL('https://claude.ai/chat');

      // Wait for page to load and capture cookies
      hiddenWindow.webContents.once('did-finish-load', async () => {
        let success = false;
        try {
          const ses = session.fromPartition('persist:claude-auth');
          const cookies = await ses.cookies.get({ domain: '.claude.ai' });
          this.cookies = cookies;

          // Get session token from cookies
          const sessionCookie = cookies.find(c =>
            c.name === 'sessionKey' ||
            c.name === '__session' ||
            c.name === 'anthropic-session'
          );

          if (sessionCookie) {
            this.sessionToken = sessionCookie.value;
          }

          // Try to get organization/subscription info
          const jsCode = `
            (function() {
              try {
                const data = {};

                // Check localStorage
                const orgId = localStorage.getItem('organizationId');
                if (orgId) data.organizationId = orgId;

                const userId = localStorage.getItem('userId');
                if (userId) data.userId = userId;

                const subscription = localStorage.getItem('subscription');
                if (subscription) data.subscription = subscription;

                // Check for API responses in session storage
                const keys = Object.keys(sessionStorage);
                for (const key of keys) {
                  if (key.includes('usage') || key.includes('subscription')) {
                    try {
                      const value = JSON.parse(sessionStorage.getItem(key));
                      if (value) data.sessionData = value;
                    } catch (e) {}
                  }
                }

                return data;
              } catch (e) {
                return { error: e.message };
              }
            })();
          `;

          const result = await hiddenWindow.webContents.executeJavaScript(jsCode);

          if (result.organizationId) {
            this.organizationId = result.organizationId;
          }
          if (result.userId) {
            this.userId = result.userId;
          }
          if (result.subscription) {
            this.subscription = result.subscription;
          }

          // Check if we successfully captured a session
          if (this.cookies && this.cookies.length > 0) {
            success = true;
            this.emit('authenticated', {
              sessionToken: this.sessionToken,
              organizationId: this.organizationId,
              cookies: this.cookies
            });
          }
        } catch (error) {
          console.error('Failed to capture session:', error);
        } finally {
          hiddenWindow.close();
          resolve(success);
        }
      });
    });
  }

  // Fetch usage data using Claude session
  async fetchUsageData() {
    if (!this.cookies) {
      throw new Error('Not authenticated');
    }

    // First, try to fetch from API endpoints
    try {
      const apiUsage = await this.fetchFromAPI();
      if (apiUsage && !apiUsage.error) {
        console.log('Got real usage from API:', apiUsage);
        return apiUsage;
      }
    } catch (error) {
      console.log('API fetch failed, falling back to UI scraping:', error.message);
    }

    // Fall back to UI scraping
    return new Promise((resolve) => {
      // Use a hidden window to fetch usage from the web UI
      const hiddenWindow = new BrowserWindow({
        width: 1,
        height: 1,
        show: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          partition: 'persist:claude-auth'
        }
      });

      // Load Claude.ai chat page
      hiddenWindow.loadURL('https://claude.ai/chat');

      // Wait for page to load and extract usage
      hiddenWindow.webContents.once('did-finish-load', async () => {
        try {
          // Wait a bit for the UI to fully render
          await new Promise(resolve => setTimeout(resolve, 2000));

          // Extract usage data from the UI
          const jsCode = `
            (function() {
              try {
                const data = { used: 0, limit: 0, subscription: 'Unknown', foundElements: [] };

                // Method 1: Look for usage in specific UI patterns
                const allText = document.body.innerText || '';

                // Pattern for "X of Y messages" or "X/Y messages"
                const usagePattern1 = /(\\d+)\\s*(?:of|\\/)\\s*(\\d+)\\s*(?:messages?|chats?|conversations?)/i;
                const match1 = allText.match(usagePattern1);
                if (match1) {
                  data.used = parseInt(match1[1]);
                  data.limit = parseInt(match1[2]);
                  data.foundElements.push('Pattern: ' + match1[0]);
                }

                // Pattern for "X messages remaining of Y"
                const usagePattern2 = /(\\d+)\\s*(?:messages?|chats?)\\s*(?:remaining|left)\\s*(?:of|out of)?\\s*(\\d+)?/i;
                const match2 = allText.match(usagePattern2);
                if (match2) {
                  if (match2[2]) {
                    data.used = parseInt(match2[2]) - parseInt(match2[1]); // remaining = limit - used
                    data.limit = parseInt(match2[2]);
                  } else {
                    data.remaining = parseInt(match2[1]);
                  }
                  data.foundElements.push('Pattern: ' + match2[0]);
                }

                // Method 2: Check for React Fiber data
                function findReactFiber(element) {
                  const key = Object.keys(element).find(key =>
                    key.startsWith('__reactFiber$') ||
                    key.startsWith('__reactInternalInstance$')
                  );
                  return element[key];
                }

                // Find all elements and check their React props
                const checkElement = (el) => {
                  try {
                    const fiber = findReactFiber(el);
                    if (fiber && fiber.memoizedProps) {
                      // Check for usage-related props
                      const props = fiber.memoizedProps;
                      if (props.usage || props.subscription || props.messages || props.limits) {
                        data.foundElements.push('React props found');
                        if (props.usage) {
                          data.used = props.usage.used || data.used;
                          data.limit = props.usage.limit || data.limit;
                        }
                        if (props.messages) {
                          data.used = props.messages.used || props.messages.current || data.used;
                          data.limit = props.messages.limit || props.messages.max || data.limit;
                        }
                      }
                    }
                  } catch (e) {}
                };

                document.querySelectorAll('div, span, p').forEach(checkElement);

                // Method 3: Check localStorage and sessionStorage
                try {
                  // Check localStorage for cached data
                  const keys = Object.keys(localStorage);
                  for (const key of keys) {
                    if (key.includes('usage') || key.includes('subscription') || key.includes('limits')) {
                      try {
                        const value = JSON.parse(localStorage.getItem(key));
                        if (value && typeof value === 'object') {
                          data.used = value.used || value.current || data.used;
                          data.limit = value.limit || value.max || data.limit;
                          data.foundElements.push('LocalStorage: ' + key);
                        }
                      } catch (e) {}
                    }
                  }

                  // Check sessionStorage
                  const sessionKeys = Object.keys(sessionStorage);
                  for (const key of sessionKeys) {
                    if (key.includes('usage') || key.includes('subscription') || key.includes('limits')) {
                      try {
                        const value = JSON.parse(sessionStorage.getItem(key));
                        if (value && typeof value === 'object') {
                          data.used = value.used || value.current || data.used;
                          data.limit = value.limit || value.max || data.limit;
                          data.foundElements.push('SessionStorage: ' + key);
                        }
                      } catch (e) {}
                    }
                  }
                } catch (e) {}

                // Method 4: Check for subscription type more thoroughly
                const subscriptionPatterns = [
                  /Claude\\s+(Pro|Team|Free|Plus)/i,
                  /Subscription:\\s*(Pro|Team|Free|Plus)/i,
                  /Plan:\\s*(Pro|Team|Free|Plus)/i
                ];

                for (const pattern of subscriptionPatterns) {
                  const subMatch = allText.match(pattern);
                  if (subMatch) {
                    data.subscription = 'Claude ' + subMatch[1];
                    data.foundElements.push('Subscription: ' + subMatch[0]);
                    break;
                  }
                }

                // Method 5: Look for specific data attributes
                document.querySelectorAll('[data-usage], [data-limit], [data-messages]').forEach(el => {
                  if (el.dataset.usage) {
                    data.used = parseInt(el.dataset.usage) || data.used;
                    data.foundElements.push('Data attribute: usage=' + el.dataset.usage);
                  }
                  if (el.dataset.limit) {
                    data.limit = parseInt(el.dataset.limit) || data.limit;
                    data.foundElements.push('Data attribute: limit=' + el.dataset.limit);
                  }
                  if (el.dataset.messages) {
                    const msgs = parseInt(el.dataset.messages);
                    if (msgs) {
                      data.used = msgs;
                      data.foundElements.push('Data attribute: messages=' + msgs);
                    }
                  }
                });

                // Method 6: Check window object for global data
                if (window.__CLAUDE_DATA__ || window.__APP_DATA__ || window.__NEXT_DATA__) {
                  const globalData = window.__CLAUDE_DATA__ || window.__APP_DATA__ || window.__NEXT_DATA__;
                  if (globalData.props?.usage) {
                    data.used = globalData.props.usage.used || data.used;
                    data.limit = globalData.props.usage.limit || data.limit;
                    data.foundElements.push('Global data found');
                  }
                }

                // Only use demo values if we found absolutely nothing
                if (!data.used && !data.limit && data.foundElements.length === 0) {
                  // Set demo values to show the UI is working
                  data.used = 25;
                  data.limit = 100;
                  data.subscription = data.subscription || 'Claude Pro';
                  data.demo = true;
                }

                // Ensure we have valid numbers
                data.used = parseInt(data.used) || 0;
                data.limit = parseInt(data.limit) || 100;

                return data;
              } catch (e) {
                return { error: e.message, used: 0, limit: 100, subscription: 'Unknown' };
              }
            })();
          `;

          const result = await hiddenWindow.webContents.executeJavaScript(jsCode);

          // Log what we found for debugging
          console.log('Scraping results:', {
            foundElements: result.foundElements,
            used: result.used,
            limit: result.limit,
            subscription: result.subscription,
            demo: result.demo
          });

          // Parse the result
          const usage = {
            used: result.used || 0,
            limit: result.limit || 100,
            resetAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24 hours from now
            subscription: result.subscription || 'Claude',
            percentage: result.limit > 0 ? Math.round((result.used / result.limit) * 100) : 0,
            demo: result.demo || false,
            foundElements: result.foundElements || []
          };

          console.log('Final usage data:', usage);
          resolve(usage);

        } catch (error) {
          console.error('Failed to extract usage:', error);
          // Return default values on error
          resolve({
            used: 0,
            limit: 100,
            resetAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            subscription: 'Claude',
            percentage: 0,
            error: true
          });
        } finally {
          hiddenWindow.close();
        }
      });
    });
  }

  // Parse usage data from Claude's format
  parseUsageData(data) {
    // Handle different possible response formats
    let usage = {
      used: 0,
      limit: 0,
      resetAt: null,
      subscription: null
    };

    // Try to extract usage from various formats
    if (data.usage) {
      if (data.usage.messagesUsed !== undefined) {
        usage.used = data.usage.messagesUsed;
      }
      if (data.usage.messagesLimit !== undefined) {
        usage.limit = data.usage.messagesLimit;
      }
      if (data.usage.resetAt) {
        usage.resetAt = data.usage.resetAt;
      }
    }

    if (data.subscription) {
      usage.subscription = data.subscription.plan || data.subscription.type;

      if (data.subscription.usage) {
        usage.used = data.subscription.usage.current || usage.used;
        usage.limit = data.subscription.usage.limit || usage.limit;
      }
    }

    // Handle message-based limits (Claude Pro/Team)
    if (data.messages) {
      usage.used = data.messages.used || data.messages.count || 0;
      usage.limit = data.messages.limit || data.messages.max || 0;
    }

    // Calculate percentage
    usage.percentage = usage.limit > 0
      ? Math.round((usage.used / usage.limit) * 100)
      : 0;

    return usage;
  }

  // Get current authentication status
  isAuthenticated() {
    return this.sessionToken !== null || this.cookies !== null;
  }

  // Clear authentication
  logout() {
    const ses = session.fromPartition('persist:claude-auth');
    ses.clearStorageData();

    this.sessionToken = null;
    this.organizationId = null;
    this.userId = null;
    this.subscription = null;
    this.cookies = null;

    this.emit('logout');
  }
}

module.exports = ClaudeAuth;