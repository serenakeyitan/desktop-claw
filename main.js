const { app, BrowserWindow, ipcMain, Menu, shell, dialog, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const UsagePoller = require('./usage-poller');
const ProxyServer = require('./proxy');
const LogWatcher = require('./watcher');
const AuthManager = require('./auth-manager');
const OpenAISubscriptionAuth = require('./openai-subscription-auth');
const UsageTracker = require('./usage-tracker');
const OpenAIUsageFetcher = require('./openai-usage-fetcher');
const AutoUsageUpdater = require('./auto-usage-updater');

// Configuration
const CONFIG_DIR = path.join(os.homedir(), '.openclaw-pet');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

let mainWindow;
let setupWindow;
let authManager;
let openaiAuth;
let usagePoller;
let proxyServer;
let logWatcher;
let usageTracker;
let openaiUsageFetcher;
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
  // Check for OpenAI subscription auth
  if (config.authType === 'openai-subscription') {
    return true; // Will check actual session state later
  }
  return false;
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
// Normalize usage blobs saved by scripts so the renderer always gets pct/reset_at
function normalizeUsageData(data, defaultSource = 'manual-file') {
  if (!data || typeof data !== 'object') {
    return null;
  }

  const limit = Number.isFinite(data.limit) ? data.limit : 100;
  let pct = Number.isFinite(data.pct) ? data.pct : undefined;

  if (pct === undefined && Number.isFinite(data.percentage)) {
    pct = data.percentage;
  }
  if (pct === undefined && Number.isFinite(data.used) && limit > 0) {
    pct = Math.round((data.used / limit) * 100);
  }
  if (!Number.isFinite(pct)) {
    pct = 0;
  }

  pct = Math.max(0, Math.min(100, pct));
  const used = Number.isFinite(data.used) ? data.used : Math.round((pct / 100) * limit);
  const resetAt = data.reset_at || data.resetAt || null;

  return {
    used,
    limit,
    pct,
    percentage: pct,
    reset_at: resetAt,
    resetAt,
    subscription: data.subscription || 'Claude Pro',
    type: data.type || '5-hour',
    realData: data.realData !== undefined ? data.realData : true,
    source: data.source || defaultSource,
    timestamp: data.timestamp || new Date().toISOString()
  };
}

function checkManualUsageFile() {
  const manualUsageFile = path.join(os.homedir(), '.openclaw-pet', 'real-usage.json');
  try {
    if (fs.existsSync(manualUsageFile)) {
      const data = JSON.parse(fs.readFileSync(manualUsageFile, 'utf8'));
      const timestamp = data.timestamp ? new Date(data.timestamp) : new Date(0);
      const age = Date.now() - timestamp.getTime();
      if (age < 6 * 60 * 60 * 1000) {
        const normalized = normalizeUsageData(data, data.source || 'manual-file');
        if (normalized) {
          console.log('Found recent manual usage data:', normalized);
          return normalized;
        }
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

  // Start the AutoUsageUpdater for Claude /status tracking
  if (!autoUsageUpdater) {
    autoUsageUpdater = new AutoUsageUpdater();

    try {
      await autoUsageUpdater.init();
      console.log('Started automatic Claude /status usage tracking');

      // Start automatic updates
      autoUsageUpdater.start(1); // Check every minute

      // Listen for updates
      autoUsageUpdater.claudeTracker.on('usage-updated', (data) => {
        if (mainWindow) {
          const normalized = normalizeUsageData(data, 'claude-status');
          mainWindow.webContents.send('token-update', normalized);
        }
      });
    } catch (error) {
      console.error('Failed to start auto usage updater:', error);
    }
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

  // Check for OpenAI subscription auth
  if (config.authType === 'openai-subscription') {
    if (!openaiAuth) {
      openaiAuth = new OpenAISubscriptionAuth();
    }

    // Load saved session
    const hasSession = openaiAuth.loadSavedSession();
    if (hasSession) {
      authMethod = 'openai-subscription';
      console.log('Using OpenAI ChatGPT Plus subscription tracking');

      // Initialize usage tracking
      openaiAuth.initializeUsageTracking();

      // Send initial usage data
      const sendUsageUpdate = () => {
        const usage = openaiAuth.getUsageData();
        if (mainWindow) {
          mainWindow.webContents.send('token-update', {
            used: usage.used,
            limit: usage.limit,
            pct: usage.percentage,
            reset_at: usage.resetAt,
            subscription: usage.subscription,
            type: usage.type,
            model: usage.model,
            realData: false,
            source: 'ChatGPT Plus tracking'
          });
        }
      };

      // Listen for usage updates
      openaiAuth.on('usage-updated', sendUsageUpdate);

      // Send initial data
      sendUsageUpdate();

      // Update every 30 seconds
      setInterval(() => {
        sendUsageUpdate();
      }, 30000);

      return;
    } else {
      console.log('No OpenAI session found, need to login');
      // Will prompt for login via setup window
    }

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
  if (autoUsageUpdater) {
    autoUsageUpdater.stop();
    autoUsageUpdater = null;
  }
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
  process.env.OPENAI_API_KEY = apiKey;
  if (setupWindow) {
    setupWindow.close();
  }
  return true;
});

ipcMain.handle('set-openai-token', async (event, tokenData) => {
  try {
    // Save token to config
    const config = loadConfig();
    config.openaiToken = tokenData;
    config.authType = 'openai-oauth';
    saveConfig(config);

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
    console.error('Failed to save OpenAI token:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('login-with-openai', async () => {
  if (!openaiAuth) {
    openaiAuth = new OpenAISubscriptionAuth();
  }

  try {
    const success = await openaiAuth.startLoginFlow();
    if (success) {
      // Store auth type
      const config = loadConfig();
      config.authType = 'openai-subscription';
      saveConfig(config);

      if (setupWindow) {
        setupWindow.close();
      }

      // Restart services with OpenAI subscription auth
      if (mainWindow) {
        cleanupServices();
        await initializeServices();
      }
    }
    return { success, method: 'openai-subscription' };
  } catch (error) {
    console.error('OpenAI login failed:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('track-openai-message', () => {
  if (openaiAuth && openaiAuth.trackMessage) {
    openaiAuth.trackMessage('gpt-4');
    return true;
  }
  return false;
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
      label: '🔐 Change OpenAI Authentication',
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
            <h3>Update OpenAI Usage</h3>
            <div class="info">Enter your current OpenAI usage percentage</div>
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

                  const now = new Date();
                  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
                  const usageData = {
                    percentage: percentage,
                    used: percentage,
                    limit: 100,
                    resetAt: endOfMonth.toISOString(),
                    subscription: 'OpenAI Plus',
                    type: 'monthly',
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
