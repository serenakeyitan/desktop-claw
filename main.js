const { app, BrowserWindow, ipcMain, Menu, shell, dialog, screen, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const UsagePoller = require('./usage-poller');
const ProxyServer = require('./proxy');
const LogWatcher = require('./watcher');
const AuthManager = require('./auth-manager');
const UsageTracker = require('./usage-tracker');
const AutoUsageUpdater = require('./auto-usage-updater');
const SessionMonitor = require('./session-monitor');

// Configuration
const CONFIG_DIR = path.join(os.homedir(), '.openclaw-pet');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

let mainWindow;
let setupWindow;
let authManager;
let usagePoller;
let proxyServer;
let logWatcher;
let usageTracker;
let autoUsageUpdater;
let sessionMonitor;
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
  // Check for Claude OAuth (via keychain - automatic)
  if (config.authType === 'claude-oauth' || config.authType === 'claude-status') {
    return true;
  }
  // Check if Claude Code credentials exist in keychain (auto-detect)
  try {
    const { execSync } = require('child_process');
    const user = require('os').userInfo().username;
    execSync(
      `security find-generic-password -a "${user}" -s "Claude Code-credentials" > /dev/null 2>&1`,
      { timeout: 3000 }
    );
    // Claude Code is logged in - use it automatically
    config.authType = 'claude-oauth';
    saveConfig(config);
    return true;
  } catch {
    // No Claude Code credentials
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
  const windowHeight = 200;
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

  // Fall back to API key authentication if Claude OAuth is not active
  if (config.authType !== 'claude-oauth' && config.authType !== 'claude-status') {
    authManager = new AuthManager();
    const authenticated = await authManager.initialize();

    if (!authenticated) {
      if (process.env.ANTHROPIC_API_KEY === 'demo') {
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

  // Start session monitor to detect active Claude Code sessions
  try {
    sessionMonitor = new SessionMonitor({ pollIntervalSeconds: 5 });

    sessionMonitor.on('session-started', (session) => {
      // Only notify for sessions that are actively working
      if (session.status === 'busy') {
        setActivityState('active');
      }
    });

    sessionMonitor.on('session-ended', (session) => {
      // Process exited entirely
      if (Notification.isSupported()) {
        new Notification({
          title: 'Claude session closed',
          body: `${session.project || 'Unknown project'} exited after ${session.duration}`,
          silent: false,
        }).show();
      }
    });

    sessionMonitor.on('session-task-finished', (data) => {
      // A session went from busy to idle — the key notification
      if (Notification.isSupported()) {
        new Notification({
          title: 'Claude finished running',
          body: `${data.project || 'Unknown project'} is done (ran for ${data.busyDuration})`,
          silent: false,
        }).show();
      }
    });

    sessionMonitor.on('session-task-started', (data) => {
      // A session went from idle to busy
      setActivityState('active');
    });

    sessionMonitor.on('sessions-updated', (data) => {
      // Forward session data to renderer
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('session-update', data);
      }

      // Only keep robot active if sessions are actually busy
      if (data.busyCount > 0) {
        setActivityState('active');
      }
    });

    sessionMonitor.start();
    console.log('Session monitor started');
  } catch (error) {
    console.error('Failed to start session monitor:', error);
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
  if (sessionMonitor) {
    sessionMonitor.stop();
    sessionMonitor = null;
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

ipcMain.handle('quit-app', () => {
  app.quit();
});

// Setup flow: check if Claude Code CLI is installed
ipcMain.handle('check-claude-installed', () => {
  try {
    const { execSync } = require('child_process');
    const claudePath = execSync('which claude', { encoding: 'utf8', timeout: 3000 }).trim();
    const version = execSync('claude --version 2>/dev/null || echo unknown', { encoding: 'utf8', timeout: 5000 }).trim();
    return { installed: true, path: claudePath, version };
  } catch {
    return { installed: false, path: null, version: null };
  }
});

// Setup flow: check if Claude Code has credentials in keychain
ipcMain.handle('check-claude-credentials', () => {
  try {
    const { execSync } = require('child_process');
    const user = os.userInfo().username;
    const raw = execSync(
      `security find-generic-password -a "${user}" -w -s "Claude Code-credentials"`,
      { encoding: 'utf8', timeout: 5000 }
    ).trim();
    const creds = JSON.parse(raw);
    if (creds.claudeAiOauth) {
      return {
        found: true,
        subscriptionType: creds.claudeAiOauth.subscriptionType || 'pro',
        hasRefreshToken: !!creds.claudeAiOauth.refreshToken,
      };
    }
    return { found: false };
  } catch {
    return { found: false };
  }
});

// Setup flow: test the API connection by fetching usage once
ipcMain.handle('test-claude-connection', async () => {
  try {
    const ClaudeOAuthUsageTracker = require('./claude-oauth-usage-tracker');
    const tracker = new ClaudeOAuthUsageTracker();
    const result = await tracker.checkUsage();
    tracker.stop();
    if (result) {
      return {
        success: true,
        usage: {
          fiveHour: result.details?.five_hour?.utilization ?? null,
          sevenDay: result.details?.seven_day?.utilization ?? null,
          resetAt: result.resetAt,
        }
      };
    }
    return { success: false, error: 'No usage data returned' };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Setup flow: save auth type and launch main window
ipcMain.handle('complete-setup', async (event, authType) => {
  const config = loadConfig();
  config.authType = authType;
  saveConfig(config);

  if (setupWindow) {
    setupWindow.close();
  }

  if (!mainWindow) {
    createMainWindow();
  }

  return { success: true };
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
            <h3>Update Usage</h3>
            <div class="info">Enter your current usage percentage</div>
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
                    subscription: 'Claude',
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
