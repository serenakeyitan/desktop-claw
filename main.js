const { app, BrowserWindow, ipcMain, Menu, shell, dialog, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const UsagePoller = require('./usage-poller');
const ProxyServer = require('./proxy');
const LogWatcher = require('./watcher');
const AuthManager = require('./auth-manager');
const ClaudeAuth = require('./claude-auth');
const UsageTracker = require('./usage-tracker');
const ClaudeUsageFetcher = require('./claude-usage-fetcher');
const AutoUsageUpdater = require('./auto-usage-updater');

// Configuration
const CONFIG_DIR = path.join(os.homedir(), '.openclaw-pet');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

let mainWindow;
let setupWindow;
let authManager;
let claudeAuth;
let usagePoller;
let proxyServer;
let logWatcher;
let usageTracker;
let claudeUsageFetcher;
let autoUsageUpdater;
let currentState = 'idle';
let lastActivityTime = Date.now();
let windowPosition = null;

// Default configuration
const DEFAULT_CONFIG = {
  poll_interval_seconds: 30,
  activity_timeout_seconds: 10,
  proxy_port: 9999,
  detection_method: 'auto',
  position: { x: null, y: null },
  window_locked: false
};

// Load or create configuration
function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }

    if (!fs.existsSync(CONFIG_FILE)) {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2));
      return DEFAULT_CONFIG;
    }

    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return { ...DEFAULT_CONFIG, ...config };
  } catch (error) {
    console.error('Error loading config:', error);
    return DEFAULT_CONFIG;
  }
}

// Save configuration
function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (error) {
    console.error('Error saving config:', error);
  }
}

// Check if authentication is available
function hasAuth() {
  const config = loadConfig();
  // Check for Claude token first (best option for real usage)
  if (config.authType === 'claude-token' && config.claudeToken) {
    return true;
  }
  // Check for Claude subscription auth
  if (config.authType === 'claude-subscription') {
    return true; // Will check actual auth state later
  }
  // Check for API key
  return !!process.env.ANTHROPIC_API_KEY;
}

// Create setup wizard window
function createSetupWindow() {
  setupWindow = new BrowserWindow({
    width: 600,
    height: 700,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    frame: true,
    resizable: true,
    minimizable: true,
    maximizable: false,
    alwaysOnTop: false,
    skipTaskbar: false,
    backgroundColor: '#1a1a1a'
  });

  setupWindow.loadFile(path.join(__dirname, 'renderer', 'setup.html'));

  setupWindow.on('closed', () => {
    setupWindow = null;
    // If this was opened for re-authentication and main window exists, just close
    if (mainWindow) {
      return;
    }
    // If still no auth, quit
    if (!hasAuth()) {
      app.quit();
    } else {
      createMainWindow();
    }
  });
}

// Create main widget window
function createMainWindow() {
  const config = loadConfig();

  // Get display bounds
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;

  // Calculate default position (bottom-right with 20px margin)
  const windowWidth = 180;
  const windowHeight = 150;
  let x = config.position.x !== null ? config.position.x : screenWidth - windowWidth - 20;
  let y = config.position.y !== null ? config.position.y : screenHeight - windowHeight - 20;

  // Ensure window is on screen
  if (x < 0 || x > screenWidth - windowWidth) x = screenWidth - windowWidth - 20;
  if (y < 0 || y > screenHeight - windowHeight) y = screenHeight - windowHeight - 20;

  mainWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    x: x,
    y: y,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    backgroundColor: '#00000000',
    vibrancy: 'none',
    type: 'panel',
    level: 'screen-saver'
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Set up click-through for transparency
  mainWindow.setIgnoreMouseEvents(false);

  // Initialize services
  initializeServices();

  // Handle window close
  mainWindow.on('closed', () => {
    mainWindow = null;
    cleanupServices();
  });

  // Save position on move
  mainWindow.on('moved', () => {
    if (mainWindow && !config.window_locked) {
      const [x, y] = mainWindow.getPosition();
      config.position = { x, y };
      saveConfig(config);
    }
  });
}

// Check for manual usage file
function checkManualUsageFile() {
  const manualUsageFile = path.join(os.homedir(), '.openclaw-pet', 'real-usage.json');
  try {
    if (fs.existsSync(manualUsageFile)) {
      const data = JSON.parse(fs.readFileSync(manualUsageFile, 'utf8'));
      // Check if data is not too old (within 6 hours)
      const timestamp = new Date(data.timestamp);
      const age = Date.now() - timestamp.getTime();
      if (age < 6 * 60 * 60 * 1000) {
        console.log('Found recent manual usage data:', data);
        return data;
      }
    }
  } catch (error) {
    console.log('Could not read manual usage file:', error);
  }
  return null;
}

// Initialize backend services
async function initializeServices() {
  const config = loadConfig();

  // Start automatic usage updater
  try {
    autoUsageUpdater = new AutoUsageUpdater();
    await autoUsageUpdater.start(2); // Update every 2 minutes
    console.log('Auto usage updater started');
  } catch (error) {
    console.log('Auto updater not available:', error.message);
  }

  // Check for manual usage data
  const manualUsage = checkManualUsageFile();
  if (manualUsage && mainWindow) {
    console.log('Using manual usage data from file');
    mainWindow.webContents.send('token-update', manualUsage);

    // Set up periodic check for manual updates
    setInterval(() => {
      const updated = checkManualUsageFile();
      if (updated && mainWindow) {
        mainWindow.webContents.send('token-update', updated);
      }
    }, 30000); // Check every 30 seconds
  }
  let authMethod = null;

  // Check for Claude token first (highest priority)
  if (config.authType === 'claude-token' && config.claudeToken) {
    if (!claudeAuth) {
      claudeAuth = new ClaudeAuth();
    }

    // Set the token for API access
    claudeAuth.oauthToken = config.claudeToken;
    authMethod = 'claude-token';
    console.log('Using Claude OAuth token for real usage data');
  }
  // Initialize Claude auth if needed
  else if (config.authType === 'claude-subscription') {
    if (!claudeAuth) {
      claudeAuth = new ClaudeAuth();
    }

    // Try to capture existing session
    try {
      const hasSession = await claudeAuth.captureSessionFromBrowser();
      if (hasSession) {
        authMethod = 'claude-subscription';
        console.log('Using Claude subscription authentication');
      }
    } catch (error) {
      console.error('Failed to capture Claude session:', error);
    }
  }

  // Check for Claude token or subscription auth first
  if (authMethod === 'claude-token' || authMethod === 'claude-subscription') {
    // First, try to use ClaudeUsageFetcher to get real usage from Claude Code
    try {
      console.log('Starting Claude usage fetcher for real data...');
      claudeUsageFetcher = new ClaudeUsageFetcher();

      // Listen for usage updates from Claude
      claudeUsageFetcher.on('usage-updated', (usageData) => {
        console.log('Got real usage data from Claude Code!');
        const primaryUsage = claudeUsageFetcher.getPrimaryUsage();
        if (primaryUsage && mainWindow) {
          mainWindow.webContents.send('token-update', {
            used: primaryUsage.used,
            limit: primaryUsage.limit,
            pct: primaryUsage.percentage,
            reset_at: primaryUsage.resetAt,
            subscription: primaryUsage.subscription,
            type: primaryUsage.type,
            realData: true,
            source: 'Claude Code /usage command'
          });
        }
      });

      // Start the fetcher with periodic checks every 5 minutes
      await claudeUsageFetcher.start();
      claudeUsageFetcher.startPeriodicCheck(5);
      console.log('Claude usage fetcher started successfully');

      // We have real usage, so return early
      return;
    } catch (error) {
      console.log('Could not start Claude usage fetcher, trying API method:', error.message);
    }

    // Fallback to API fetch method (which we know doesn't work, but keep as backup)
    const fetchRealUsage = async () => {
      try {
        const apiUsage = await claudeAuth.fetchFromAPI();
        if (apiUsage && !apiUsage.error) {
          console.log('Using real API usage data:', apiUsage);
          if (mainWindow) {
            mainWindow.webContents.send('token-update', {
              used: apiUsage.used,
              limit: apiUsage.limit,
              pct: apiUsage.percentage || apiUsage.used, // OAuth returns percentage as used
              reset_at: apiUsage.resetAt,
              subscription: apiUsage.subscription,
              type: 'messages',
              realData: true,
              weeklyUsed: apiUsage.weeklyUsed,
              weeklyResetAt: apiUsage.weeklyResetAt,
              source: apiUsage.source
            });
          }
          return true;
        }
      } catch (error) {
        console.log('Could not fetch real usage, falling back to local tracking');
      }
      return false;
    };

    // Try to get real usage first
    const hasRealUsage = await fetchRealUsage();

    if (!hasRealUsage) {
      // Fall back to local tracking if API doesn't work
      usageTracker = new UsageTracker();

      // Send initial usage data
      const sendUsageUpdate = () => {
        const usage = usageTracker.getUsageData();
        if (mainWindow) {
          mainWindow.webContents.send('token-update', {
            used: usage.used,
            limit: usage.limit,
            pct: usage.percentage,
            reset_at: usage.resetAt,
            subscription: usage.subscription,
            type: 'messages',
            realTracking: true,
            remaining: usage.remaining
          });
        }
      };

      // Listen for usage updates
      usageTracker.on('usage-updated', sendUsageUpdate);

      // Send initial data
      sendUsageUpdate();
    }

    // Update every 30 seconds to refresh
    setInterval(async () => {
      const gotReal = await fetchRealUsage();
      if (!gotReal && usageTracker) {
        const usage = usageTracker.getUsageData();
        if (mainWindow) {
          mainWindow.webContents.send('token-update', {
            used: usage.used,
            limit: usage.limit,
            pct: usage.percentage,
            reset_at: usage.resetAt,
            subscription: usage.subscription,
            type: 'messages',
            realTracking: true,
            remaining: usage.remaining
          });
        }
      }
    }, 30000);

  } else {
    // Fall back to API key authentication
    authManager = new AuthManager();
    const authenticated = await authManager.initialize();

    if (!authenticated) {
      // No authentication available - show error or demo mode
      if (process.env.ANTHROPIC_API_KEY === 'demo') {
        // Demo mode
        authManager = null;
      } else {
        mainWindow.webContents.send('token-update', {
          used: 0,
          limit: 0,
          pct: 0,
          reset_at: null,
          error: 'No authentication'
        });
        return;
      }
    }

    // Start usage polling with auth manager
    usagePoller = new UsagePoller(authManager, config.poll_interval_seconds);
    usagePoller.on('update', (data) => {
      if (mainWindow) {
        mainWindow.webContents.send('token-update', data);
      }
    });
    usagePoller.on('activity', () => {
      setActivityState('active');
    });
    usagePoller.start();
  }

  // Start proxy server (Method A)
  try {
    const apiKey = authManager ? authManager.apiKey : null;
    proxyServer = new ProxyServer(config.proxy_port, apiKey);
    proxyServer.on('activity', () => {
      setActivityState('active');
      // Track message if using Claude subscription
      if (usageTracker) {
        usageTracker.trackMessage('api_call');
        console.log('Tracked API call - real usage updated');
      }
    });
    proxyServer.start();
    console.log(`Proxy server started on port ${config.proxy_port}`);
  } catch (error) {
    console.error('Failed to start proxy server:', error);
  }

  // Start log watcher (Method B)
  try {
    logWatcher = new LogWatcher();
    logWatcher.on('activity', () => {
      setActivityState('active');
    });
    logWatcher.start();
    console.log('Log watcher started');
  } catch (error) {
    console.error('Failed to start log watcher:', error);
  }
}

// Cleanup services
function cleanupServices() {
  if (usagePoller) {
    usagePoller.stop();
    usagePoller = null;
  }
  if (proxyServer) {
    proxyServer.stop();
    proxyServer = null;
  }
  if (logWatcher) {
    logWatcher.stop();
    logWatcher = null;
  }
}

// Set activity state
function setActivityState(state) {
  const config = loadConfig();
  lastActivityTime = Date.now();

  if (state !== currentState) {
    currentState = state;
    if (mainWindow) {
      mainWindow.webContents.send('state-change', { state });
    }
  }

  // Reset to idle after timeout
  if (state === 'active') {
    setTimeout(() => {
      const timeSinceActivity = Date.now() - lastActivityTime;
      if (timeSinceActivity >= config.activity_timeout_seconds * 1000) {
        setActivityState('idle');
      }
    }, config.activity_timeout_seconds * 1000);
  }
}

// IPC handlers
ipcMain.handle('get-config', () => {
  return loadConfig();
});

ipcMain.handle('save-config', (event, newConfig) => {
  saveConfig(newConfig);
  return true;
});

ipcMain.handle('open-config', () => {
  shell.openPath(CONFIG_FILE);
});

ipcMain.handle('set-env-api-key', (event, apiKey) => {
  process.env.ANTHROPIC_API_KEY = apiKey;
  if (setupWindow) {
    setupWindow.close();
  }
  return true;
});

ipcMain.handle('set-claude-token', async (event, token) => {
  try {
    // Save token to config
    const config = loadConfig();
    config.claudeToken = token;
    config.authType = 'claude-token';
    saveConfig(config);

    // Set it as environment variable for easy access
    process.env.CLAUDE_OAUTH_TOKEN = token;

    // Restart services with new authentication if main window exists
    if (mainWindow) {
      cleanupServices();
      await initializeServices();
    }

    if (setupWindow) {
      setupWindow.close();
    }

    return { success: true };
  } catch (error) {
    console.error('Failed to save Claude token:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('start-oauth-login', async () => {
  if (!authManager) {
    authManager = new AuthManager();
  }

  try {
    const success = await authManager.startOAuthFlow();
    if (success && setupWindow) {
      setupWindow.close();
    }
    return { success, method: 'oauth' };
  } catch (error) {
    console.error('OAuth login failed:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('login-with-claude', async () => {
  if (!claudeAuth) {
    claudeAuth = new ClaudeAuth();
  }

  try {
    const success = await claudeAuth.startLoginFlow();
    if (success) {
      // Store auth type
      const config = loadConfig();
      config.authType = 'claude-subscription';
      saveConfig(config);

      if (setupWindow) {
        setupWindow.close();
      }

      // Restart services with Claude auth
      if (mainWindow) {
        initializeServices();
      }
    }
    return { success, method: 'claude-subscription' };
  } catch (error) {
    console.error('Claude login failed:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('quit-app', () => {
  app.quit();
});

ipcMain.handle('track-message', () => {
  if (usageTracker) {
    usageTracker.trackMessage('manual');
    return true;
  }
  return false;
});

// Context menu
ipcMain.handle('show-context-menu', (event) => {
  const template = [
    {
      label: '🔐 Change Authentication',
      click: () => {
        // Open setup wizard for re-login
        if (!setupWindow) {
          createSetupWindow();
        } else {
          setupWindow.focus();
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Reload',
      click: () => {
        if (mainWindow) {
          mainWindow.reload();
        }
      }
    },
    {
      label: 'Open Config',
      click: () => {
        shell.openPath(CONFIG_FILE);
      }
    },
    {
      label: '📊 Update Usage',
      click: () => {
        // Create a simple input window for usage update
        const inputWindow = new BrowserWindow({
          width: 400,
          height: 200,
          resizable: false,
          minimizable: false,
          maximizable: false,
          webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
          },
          title: 'Update Usage'
        });

        inputWindow.loadURL(`data:text/html,
          <!DOCTYPE html>
          <html>
          <head>
            <style>
              body {
                font-family: system-ui, -apple-system, sans-serif;
                padding: 20px;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
              }
              h3 { margin-top: 0; }
              input {
                width: 100%;
                padding: 8px;
                font-size: 16px;
                border: none;
                border-radius: 4px;
                margin: 10px 0;
              }
              button {
                background: white;
                color: #667eea;
                border: none;
                padding: 10px 20px;
                border-radius: 4px;
                font-size: 14px;
                cursor: pointer;
                margin-right: 10px;
              }
              button:hover {
                opacity: 0.9;
              }
              .info {
                font-size: 12px;
                opacity: 0.9;
                margin-bottom: 15px;
              }
            </style>
          </head>
          <body>
            <h3>Update Claude Usage</h3>
            <div class="info">Run /usage in Claude Code to see your current usage</div>
            <input type="number" id="usage" placeholder="Enter percentage (0-100)" min="0" max="100" autofocus>
            <div style="margin-top: 20px;">
              <button onclick="save()">Save</button>
              <button onclick="window.close()">Cancel</button>
            </div>
            <script>
              const {ipcRenderer} = require('electron');
              function save() {
                const value = document.getElementById('usage').value;
                const percentage = parseInt(value);
                if (!isNaN(percentage) && percentage >= 0 && percentage <= 100) {
                  const fs = require('fs');
                  const path = require('path');
                  const os = require('os');
                  const usageFile = path.join(os.homedir(), '.openclaw-pet', 'real-usage.json');
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
                    source: 'manual-menu'
                  };

                  fs.writeFileSync(usageFile, JSON.stringify(usageData, null, 2));
                  window.close();
                } else {
                  alert('Please enter a valid percentage between 0 and 100');
                }
              }
              document.getElementById('usage').addEventListener('keypress', (e) => {
                if (e.key === 'Enter') save();
              });
            </script>
          </body>
          </html>
        `);

        inputWindow.on('close', () => {
          // Reload main window to show new usage
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.reload();
          }
        });
      }
    },
    { type: 'separator' },
    {
      label: 'Lock Position',
      type: 'checkbox',
      checked: loadConfig().window_locked,
      click: (menuItem) => {
        const config = loadConfig();
        config.window_locked = menuItem.checked;
        saveConfig(config);
      }
    },
    { type: 'separator' },
    {
      label: 'DevTools',
      click: () => {
        if (mainWindow) {
          mainWindow.webContents.openDevTools({ mode: 'detach' });
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.quit();
      }
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  menu.popup(BrowserWindow.fromWebContents(event.sender));
});

// App event handlers
app.whenReady().then(() => {
  // Check if authentication exists
  if (!hasAuth()) {
    createSetupWindow();
  } else {
    createMainWindow();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    if (!hasAuth()) {
      createSetupWindow();
    } else {
      createMainWindow();
    }
  }
});

// Handle drag movement
ipcMain.handle('set-window-position', (event, { x, y }) => {
  if (mainWindow) {
    const config = loadConfig();
    if (!config.window_locked) {
      mainWindow.setPosition(Math.round(x), Math.round(y));
    }
  }
});