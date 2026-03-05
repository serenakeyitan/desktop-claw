// ── EPIPE protection ─────────────────────────────────────────────────────
// Must be the VERY FIRST thing that runs, before any require() that might
// call log at import time.
//
// Electron pipes stdout/stderr to the parent process (or nowhere when
// launched from Finder). When that pipe breaks, Socket._write throws EPIPE
// synchronously from native code. We patch the write() method on the actual
// socket objects so the throw is caught before it reaches Console internals.
(function installEpipeProtection() {
  function patchStream(stream) {
    if (!stream || typeof stream.write !== 'function') return;
    const origWrite = stream.write;
    stream.write = function (chunk, encoding, callback) {
      try {
        return origWrite.call(this, chunk, encoding, callback);
      } catch (e) {
        if (e.code === 'EPIPE' || e.code === 'ERR_STREAM_DESTROYED') return true;
        throw e;
      }
    };
    stream.on('error', (err) => {
      if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') return;
      throw err;
    });
  }
  patchStream(process.stdout);
  patchStream(process.stderr);

  process.on('uncaughtException', (err) => {
    if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') return;
    try { process.stderr.write(`Uncaught exception: ${err.stack || err}\n`); } catch (_) {}
    process.exit(1);
  });
})();
// ── End EPIPE protection ─────────────────────────────────────────────────

const { app, BrowserWindow, ipcMain, Menu, shell, dialog, screen, Notification, nativeImage } = require('electron');
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
const UsageDB = require('./usage-db');
const supabaseClient = require('./supabase-client');
const SocialSync = require('./social-sync');
const { getClaudeBinaryPath } = require('./claude-path');
const log = require('./logger');

// ── PATH enrichment for macOS GUI launches ────────────────────────────────
// When launched from Finder / DMG (not a terminal), macOS gives Electron a
// minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin). This means `which claude`
// and other lookups fail even though the CLI is installed. Prepend common
// binary directories so child_process calls work the same as in a terminal.
(function enrichPath() {
  if (process.platform !== 'darwin') return;
  const home = os.homedir();
  const extra = [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    path.join(home, '.nvm/versions/node'),   // parent — we glob below
    path.join(home, '.local/bin'),
    path.join(home, '.npm-global/bin'),
    path.join(home, '.volta/bin'),
  ];

  // For nvm: find the latest installed node version directory
  const nvmRoot = path.join(home, '.nvm/versions/node');
  try {
    if (fs.existsSync(nvmRoot)) {
      const versions = fs.readdirSync(nvmRoot)
        .filter(d => d.startsWith('v'))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      if (versions.length > 0) {
        extra.push(path.join(nvmRoot, versions[0], 'bin'));
      }
    }
  } catch { /* ignore */ }

  // For fnm: check common install location
  const fnmRoot = path.join(home, 'Library/Application Support/fnm/node-versions');
  try {
    if (fs.existsSync(fnmRoot)) {
      const versions = fs.readdirSync(fnmRoot)
        .filter(d => d.startsWith('v'))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      if (versions.length > 0) {
        extra.push(path.join(fnmRoot, versions[0], 'installation/bin'));
      }
    }
  } catch { /* ignore */ }

  const current = process.env.PATH || '';
  const dirs = current.split(':');
  const toAdd = extra.filter(d => d && !dirs.includes(d));
  if (toAdd.length > 0) {
    process.env.PATH = toAdd.join(':') + ':' + current;
    log(`PATH enriched with: ${toAdd.join(', ')}`);
  }
})();

// ── Auto-updater ────────────────────────────────────────────────────────────
let updaterInstance = null;
let updateState = { status: 'idle', version: null, progress: 0, error: null };
// status: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'error'

function sendUpdateStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-status', updateState);
  }
}

function initAutoUpdater() {
  try {
    const { autoUpdater } = require('electron-updater');
    updaterInstance = autoUpdater;
    autoUpdater.autoDownload = false;  // We'll prompt the user first
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('checking-for-update', () => {
      log('Checking for updates...');
      updateState = { status: 'checking', version: null, progress: 0, error: null };
      sendUpdateStatus();
    });

    autoUpdater.on('update-available', (info) => {
      log('Update available:', info.version);
      updateState = { status: 'available', version: info.version, progress: 0, error: null };
      sendUpdateStatus();
    });

    autoUpdater.on('update-not-available', (info) => {
      log('Already up to date:', info.version);
      updateState = { status: 'not-available', version: info.version, progress: 0, error: null };
      sendUpdateStatus();
    });

    autoUpdater.on('download-progress', (progress) => {
      updateState = { ...updateState, status: 'downloading', progress: Math.round(progress.percent) };
      sendUpdateStatus();
    });

    autoUpdater.on('update-downloaded', (info) => {
      log('Update downloaded:', info.version, '— ready to install');
      updateState = { status: 'downloaded', version: info.version, progress: 100, error: null };
      sendUpdateStatus();
    });

    autoUpdater.on('error', (err) => {
      log('Auto-updater error:', err.message);
      updateState = { status: 'error', version: null, progress: 0, error: err.message };
      sendUpdateStatus();
    });

    // Check on startup (silent — the renderer will show a popup if update is available)
    autoUpdater.checkForUpdates().catch(() => {});

    // Check periodically (every 4 hours)
    setInterval(() => {
      autoUpdater.checkForUpdates().catch(() => {});
    }, 4 * 60 * 60 * 1000);

  } catch (err) {
    // electron-updater not available (e.g., running from source with npx electron .)
    log('Auto-updater skipped:', err.message);
  }
}

// Configuration
const CONFIG_DIR = path.join(os.homedir(), '.alldaypoke');
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
let usageDB;
let rankingWindow;
let loginWindow;
let socialWindow;
let socialSync;
let lastUsagePct = null;  // tracks last OAuth utilization for delta computation
let pendingInviteCode = null;  // queued invite code from deep link, processed after login
let pendingWindowAfterLogin = null;  // window to open after login completes ('social')
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
  robot_scale: 0.6,
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
    log.error('Error loading config:', error);
    return DEFAULT_CONFIG;
  }
}

// Save configuration
function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (error) {
    log.error('Error saving config:', error);
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
    const { execFileSync } = require('child_process');
    const user = require('os').userInfo().username;
    execFileSync(
      'security',
      ['find-generic-password', '-a', user, '-s', 'Claude Code-credentials'],
      { timeout: 3000, stdio: 'ignore' }
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
// opts.reauth: when true, the setup wizard skips the CLI-installed check
// and jumps straight to credential verification (used when re-authenticating
// from an already-running app whose token expired).
function createSetupWindow(opts = {}) {
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

  // Pass reauth flag as a query param so the renderer can skip the CLI check
  const setupUrl = new URL('file://' + path.join(__dirname, 'renderer', 'setup.html'));
  if (opts.reauth) {
    setupUrl.searchParams.set('reauth', '1');
  }
  setupWindow.loadURL(setupUrl.href);

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
  const windowHeight = 240;
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
    show: false,              // Wait for ready-to-show to avoid partial render
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

  // Don't show the window until content is fully painted — avoids the
  // macOS bug where transparent frameless windows render blank/partial.
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();

    // Force macOS to composite the transparent window by nudging it
    // 1px and back.  This is the most reliable workaround for the
    // blank-window bug on macOS with transparent + frameless windows.
    const [cx, cy] = mainWindow.getPosition();
    mainWindow.setPosition(cx + 1, cy);
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setPosition(cx, cy);
      }
    }, 50);

    // Belt-and-suspenders: force a full repaint via the renderer
    if (mainWindow.webContents) {
      mainWindow.webContents.invalidate();
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Click-through: ignore mouse on transparent areas, forward events so renderer can detect hover
  mainWindow.setIgnoreMouseEvents(true, { forward: true });

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

// Return a human-readable subscription label from the last known tier persisted
// in config. Avoids showing "Claude Pro" to Max users during a disconnection.
function _lastKnownSubscriptionLabel() {
  try {
    const cfg = loadConfig();
    const tier = cfg.lastKnownTier;
    if (tier === 'max_200') return 'Claude Max ($200)';
    if (tier === 'max_100') return 'Claude Max';
    if (tier) return 'Claude Pro';
  } catch { /* ignore */ }
  return 'Claude Pro';
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
    subscription: data.subscription || _lastKnownSubscriptionLabel(),
    type: data.type || '5-hour',
    realData: data.realData !== undefined ? data.realData : true,
    source: data.source || defaultSource,
    timestamp: data.timestamp || new Date().toISOString()
  };
}

function checkManualUsageFile() {
  const manualUsageFile = path.join(os.homedir(), '.alldaypoke', 'real-usage.json');
  try {
    if (fs.existsSync(manualUsageFile)) {
      const data = JSON.parse(fs.readFileSync(manualUsageFile, 'utf8'));
      const timestamp = data.timestamp ? new Date(data.timestamp) : new Date(0);
      const age = Date.now() - timestamp.getTime();
      if (age < 6 * 60 * 60 * 1000) {
        const normalized = normalizeUsageData(data, data.source || 'manual-file');
        if (normalized) {
          log('Found recent manual usage data:', normalized);
          return normalized;
        }
      }
    }
  } catch (error) {
    log('Could not read manual usage file:', error);
  }
  return null;
}

// Initialize backend services
async function initializeServices() {
  const config = loadConfig();

  // Initialize usage history database
  if (!usageDB) {
    usageDB = new UsageDB();
    log('Usage history database loaded');
  }

  // Start the AutoUsageUpdater for Claude /status tracking
  if (!autoUsageUpdater) {
    autoUsageUpdater = new AutoUsageUpdater();

    try {
      await autoUsageUpdater.init();
      log('Started automatic Claude /status usage tracking');

      // Start automatic updates
      autoUsageUpdater.start(1); // Check every minute

      // ── Login retry detection ──────────────────────────────────────────
      // When Claude Code credentials go missing or expire, prompt re-login.
      autoUsageUpdater.claudeTracker.on('auth-needed', (data) => {
        log(`Auth needed detected: ${data.reason} (${data.failures} failures)`);

        // Notify the user
        if (Notification.isSupported()) {
          new Notification({
            title: 'Claude login required',
            body: 'Claude Code credentials expired or missing. Click the robot and re-authenticate.',
            silent: false,
          }).show();
        }

        // Send auth-error state to the renderer so the robot shows an indicator
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('token-update', {
            used: 0,
            limit: 0,
            pct: 0,
            reset_at: null,
            error: 'auth-needed',
            authNeeded: true,
          });
        }

        // Auto-open the setup window for re-authentication
        // Pass reauth flag so the wizard skips the CLI-installed check
        // (we know it's installed — the token just expired).
        if (!setupWindow) {
          createSetupWindow({ reauth: true });
        } else {
          setupWindow.focus();
        }
      });

      autoUsageUpdater.claudeTracker.on('auth-recovered', () => {
        log('Auth recovered — credentials are valid again');

        // Clear the auth-error state on the renderer
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('auth-recovered');
        }
      });

      // Listen for updates — attribute usage deltas to busy sessions
      autoUsageUpdater.claudeTracker.on('usage-updated', (data) => {
        if (mainWindow) {
          const normalized = normalizeUsageData(data, 'claude-status');
          mainWindow.webContents.send('token-update', normalized);
        }

        // Persist the subscription tier so it survives disconnections.
        // Without this, a token expiry would cause every tier lookup to
        // fall back to 'pro', showing the wrong plan to non-Pro users.
        if (data.subscriptionTier) {
          const cfg = loadConfig();
          if (cfg.lastKnownTier !== data.subscriptionTier) {
            cfg.lastKnownTier = data.subscriptionTier;
            saveConfig(cfg);
          }
        }

        // Sync subscription tier to Supabase profile
        if (socialSync && data.subscriptionTier) {
          socialSync.setSubscriptionTier(data.subscriptionTier);
        }

        // Keep UsageDB's current tier up-to-date so legacy entries
        // (without a stored tier) convert using the correct plan.
        if (usageDB && data.subscriptionTier) {
          usageDB.setCurrentTier(data.subscriptionTier);
        }

        // Attribution: compute delta and assign to busy sessions.
        // Pass the subscription tier so token counts are computed correctly
        // even if the user later switches plans.
        if (usageDB && sessionMonitor) {
          const currentPct = data.percentage ?? data.pct ?? null;
          const tier = data.subscriptionTier || loadConfig().lastKnownTier || 'pro';
          if (currentPct !== null && lastUsagePct !== null) {
            const delta = currentPct - lastUsagePct;
            if (delta > 0) {
              // Get currently busy sessions
              const sessions = sessionMonitor.getSessions();
              const busySessions = sessions.filter(s => s.busy);

              if (busySessions.length > 0) {
                // Split delta equally among busy sessions
                const perSession = delta / busySessions.length;
                for (const s of busySessions) {
                  const project = s.project || (s.cwd ? require('path').basename(s.cwd) : 'session');
                  // Estimate active time as the full poll interval (60s)
                  usageDB.recordUsage(project, perSession, 60000, tier);
                }
                log(`Usage attributed: +${delta.toFixed(1)}% (${tier}) to ${busySessions.map(s => s.project).join(', ')}`);
              } else {
                // No busy sessions — attribute to "other" (web usage, etc.)
                usageDB.recordUsage('(other)', delta, 0, tier);
                log(`Usage attributed: +${delta.toFixed(1)}% (${tier}) to (other) — no active sessions`);
              }
            }
          }
          lastUsagePct = data.percentage ?? data.pct ?? lastUsagePct;
        }
      });
    } catch (error) {
      log.error('Failed to start auto usage updater:', error);
    }
  }

  // Check for manual usage data
  const manualUsage = checkManualUsageFile();
  if (manualUsage && mainWindow) {
    log('Using manual usage data from file');
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
        log('Tracked API call - real usage updated');
      }
    });
    proxyServer.start();
    log(`Proxy server started on port ${config.proxy_port}`);
  } catch (error) {
    log.error('Failed to start proxy server:', error);
  }

  // Start log watcher (Method B)
  try {
    logWatcher = new LogWatcher();
    logWatcher.on('activity', () => {
      setActivityState('active');
    });
    logWatcher.start();
    log('Log watcher started');
  } catch (error) {
    log.error('Failed to start log watcher:', error);
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

    // Track last notification time per project to prevent duplicates
    const lastNotificationAt = new Map();
    const NOTIFICATION_DEDUP_MS = 60 * 1000; // 60-second dedup window at notification level

    sessionMonitor.on('session-task-finished', (data) => {
      // A session went from busy to idle — the key notification
      // Secondary dedup: guard against multiple events reaching here for the same project
      const key = data.project || (data.cwd ? require('path').basename(data.cwd) : data.id);
      const now = Date.now();
      const lastTime = lastNotificationAt.get(key) || 0;
      if (now - lastTime < NOTIFICATION_DEDUP_MS) {
        log(`Notification suppressed (dedup): ${key} — last notified ${Math.round((now - lastTime) / 1000)}s ago`);
        return;
      }
      lastNotificationAt.set(key, now);

      if (Notification.isSupported()) {
        new Notification({
          title: 'Claude finished running',
          body: `${data.project || 'Session'} is done (ran for ${data.busyDuration})`,
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
    log('Session monitor started');
  } catch (error) {
    log.error('Failed to start session monitor:', error);
  }

  // Try to restore a previous Supabase social session
  try {
    const restoredUser = await supabaseClient.restoreSession();
    if (restoredUser) {
      log('Supabase session restored for', restoredUser.email);
      await startSocialSync();
    }
  } catch (error) {
    log('No Supabase session to restore:', error.message);
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
  stopPokePolling();
  if (socialSync) {
    socialSync.stop();
    socialSync = null;
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

// ── Update IPC handlers ─────────────────────────────────────────────────────
ipcMain.handle('check-for-updates', () => {
  if (updaterInstance) {
    updaterInstance.checkForUpdates().catch(() => {});
  } else {
    // Running from source — fall back to GitHub API check
    checkForUpdatesManual();
  }
  return updateState;
});

ipcMain.handle('download-update', () => {
  if (updaterInstance && updateState.status === 'available') {
    updaterInstance.downloadUpdate().catch(() => {});
  }
});

ipcMain.handle('install-update', () => {
  if (updaterInstance && updateState.status === 'downloaded') {
    updaterInstance.quitAndInstall(false, true);
  }
});

ipcMain.handle('get-update-status', () => {
  return updateState;
});

ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

// Manual update check via GitHub API (fallback for unsigned/source builds)
async function checkForUpdatesManual() {
  try {
    updateState = { status: 'checking', version: null, progress: 0, error: null };
    sendUpdateStatus();

    const https = require('https');
    const data = await new Promise((resolve, reject) => {
      https.get('https://api.github.com/repos/serenakeyitan/desktop-claw/releases/latest', {
        headers: { 'User-Agent': 'AllDayPoke' }
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => resolve(JSON.parse(body)));
        res.on('error', reject);
      }).on('error', reject);
    });

    const latestVersion = (data.tag_name || '').replace(/^v/, '');
    const currentVersion = app.getVersion();

    if (latestVersion && latestVersion !== currentVersion) {
      updateState = { status: 'available', version: latestVersion, progress: 0, error: null, manualUrl: data.html_url };
      sendUpdateStatus();
    } else {
      updateState = { status: 'not-available', version: currentVersion, progress: 0, error: null };
      sendUpdateStatus();
    }
  } catch (err) {
    log('Manual update check failed:', err.message);
    updateState = { status: 'error', version: null, progress: 0, error: err.message };
    sendUpdateStatus();
  }
}

// IPC handlers
ipcMain.handle('get-config', () => {
  return loadConfig();
});

ipcMain.handle('save-config', (event, newConfig) => {
  if (!newConfig || typeof newConfig !== 'object') return false;
  saveConfig(newConfig);
  return true;
});

ipcMain.handle('open-config', () => {
  shell.openPath(CONFIG_FILE);
});

ipcMain.handle('quit-app', () => {
  app.quit();
});

// Save manual usage from the Update Usage popup (secure IPC replacement)
ipcMain.handle('save-manual-usage', (event, percentage) => {
  // Validate input
  const pct = parseInt(percentage);
  if (isNaN(pct) || pct < 0 || pct > 100) {
    return { error: 'Invalid percentage' };
  }

  const usageFile = path.join(os.homedir(), '.alldaypoke', 'real-usage.json');
  const dir = path.dirname(usageFile);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const now = new Date();
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const usageData = {
    percentage: pct,
    used: pct,
    limit: 100,
    resetAt: endOfMonth.toISOString(),
    subscription: 'Claude',
    type: 'monthly',
    realData: true,
    timestamp: now.toISOString(),
    source: 'manual-menu'
  };

  fs.writeFileSync(usageFile, JSON.stringify(usageData, null, 2));
  return { success: true };
});

// Close the usage popup window
ipcMain.handle('close-usage-window', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) {
    win.close();
  }
});

// Setup flow: check if Claude Code CLI is installed
// Uses claude-path.js multi-strategy detection (env var → which → platform dirs)
// so this works even when launched from Finder with a minimal PATH.
ipcMain.handle('check-claude-installed', () => {
  try {
    const claudePath = getClaudeBinaryPath();
    let version = 'unknown';
    try {
      const { execFileSync } = require('child_process');
      version = execFileSync(claudePath, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
    } catch { /* version check may fail */ }
    return { installed: true, path: claudePath, version };
  } catch {
    return { installed: false, path: null, version: null };
  }
});

// Setup flow: check if Claude Code has credentials in keychain
ipcMain.handle('check-claude-credentials', () => {
  try {
    const { execFileSync } = require('child_process');
    const user = os.userInfo().username;
    const raw = execFileSync(
      'security',
      ['find-generic-password', '-a', user, '-w', '-s', 'Claude Code-credentials'],
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
  if (typeof authType !== 'string') return { error: 'Invalid auth type' };
  const config = loadConfig();
  config.authType = authType;
  saveConfig(config);

  if (setupWindow) {
    setupWindow.close();
  }

  if (!mainWindow) {
    createMainWindow();
  } else {
    // Re-authentication flow: main window already exists.
    // Reset the tracker's failure state and force a fresh credential check
    // so the robot immediately picks up the new/refreshed credentials.
    if (autoUsageUpdater && autoUsageUpdater.claudeTracker) {
      const tracker = autoUsageUpdater.claudeTracker;
      tracker.consecutiveAuthFailures = 0;
      tracker.authNeededEmitted = false;
      tracker.cachedToken = null;
      tracker.cachedTokenExpiresAt = 0;

      // Immediately fetch fresh usage and push to renderer
      tracker.checkUsage().then((data) => {
        if (data && mainWindow && !mainWindow.isDestroyed()) {
          const normalized = normalizeUsageData(data, 'claude-status');
          mainWindow.webContents.send('token-update', normalized);
          mainWindow.webContents.send('auth-recovered');
        }
      }).catch(() => {});
    }
  }

  // Trigger onboarding for first-time users
  if (!config.onboarding_done) {
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('start-onboarding');
      }
    }, 1500);
  }

  return { success: true };
});

ipcMain.handle('onboarding-done', () => {
  const config = loadConfig();
  config.onboarding_done = true;
  saveConfig(config);
});

ipcMain.handle('track-message', () => {
  if (usageTracker) {
    usageTracker.trackMessage('manual');
    return true;
  }
  return false;
});

// Ranking window
function openRankingWindow() {
  if (rankingWindow && !rankingWindow.isDestroyed()) {
    rankingWindow.focus();
    return;
  }

  rankingWindow = new BrowserWindow({
    width: 420,
    height: 500,
    resizable: true,
    minimizable: true,
    maximizable: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload-ranking.js'),
    },
    backgroundColor: '#0d0d0d',
    title: 'Usage Ranking',
  });

  rankingWindow.loadFile(path.join(__dirname, 'renderer', 'ranking.html'));

  rankingWindow.on('closed', () => {
    rankingWindow = null;
  });
}

// IPC: fetch ranking data for the ranking window
ipcMain.handle('get-ranking', (event, period) => {
  const validPeriods = ['today', '7d', '30d', 'all'];
  const safePeriod = validPeriods.includes(period) ? period : 'all';
  if (!usageDB) usageDB = new UsageDB();
  const ranking = usageDB.getRanking(safePeriod);
  const total = usageDB.getTotalUsage(safePeriod);
  return { ranking, total };
});

// ── Social: window launchers ─────────────────────────────────────────────

function openLoginWindow() {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus();
    return;
  }

  loginWindow = new BrowserWindow({
    width: 380,
    height: 480,
    minWidth: 300,
    minHeight: 380,
    resizable: true,
    minimizable: true,
    maximizable: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload-social.js'),
    },
    backgroundColor: '#0d0d0d',
    title: 'All Day Poke — Login',
  });

  loginWindow.loadFile(path.join(__dirname, 'renderer', 'login.html'));
  loginWindow.on('closed', () => { loginWindow = null; });
}

function openSocialWindow() {
  if (socialWindow && !socialWindow.isDestroyed()) {
    socialWindow.focus();
    return;
  }

  socialWindow = new BrowserWindow({
    width: 480,
    height: 560,
    minWidth: 320,
    minHeight: 380,
    resizable: true,
    minimizable: true,
    maximizable: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload-social.js'),
    },
    backgroundColor: '#0d0d0d',
    title: 'All Day Poke — Social Ranking',
  });

  socialWindow.loadFile(path.join(__dirname, 'renderer', 'social.html'));
  socialWindow.on('closed', () => { socialWindow = null; });
}

// Open the window that was pending before login (e.g., Social Ranking)
function openPendingWindow() {
  const target = pendingWindowAfterLogin;
  pendingWindowAfterLogin = null;
  if (target === 'social') {
    // Small delay so the login window fully closes first
    setTimeout(() => openSocialWindow(), 300);
  }
}

// ── Social: start sync after login ──────────────────────────────────────

async function startSocialSync() {
  if (!usageDB) usageDB = new UsageDB();
  if (socialSync) socialSync.stop();

  socialSync = new SocialSync(usageDB);
  await socialSync.start();
  startPokePolling();
  log('Social sync started');

  // If session monitor is active, feed vibing status
  // Any open Claude Code session = vibing (LIVE), not just busy ones
  if (sessionMonitor) {
    const updateVibing = (data) => {
      const allSessions = data.sessions || [];
      const allProjects = allSessions
        .map(s => s.project)
        .filter(Boolean);
      const isVibing = allSessions.length > 0;
      const projectStr = allProjects.join(', ') || null;
      socialSync.setVibing(isVibing, projectStr).catch(() => {});
    };
    sessionMonitor.on('sessions-updated', updateVibing);
  }
}

// ── Social IPC handlers ─────────────────────────────────────────────────

ipcMain.handle('social-sign-up', async (event, email, password, username, twitter, github) => {
  if (typeof email !== 'string' || typeof password !== 'string' || typeof username !== 'string') {
    return { error: 'Invalid input' };
  }
  try {
    const result = await supabaseClient.signUp(email, password, username,
      typeof twitter === 'string' ? twitter : undefined,
      typeof github === 'string' ? github : undefined);
    // Start sync after signup
    await startSocialSync();
    // Process pending invite code from deep link (auto-add friend)
    let friendAdded = null;
    if (pendingInviteCode && socialSync) {
      try {
        const addResult = await socialSync.addFriend(pendingInviteCode);
        if (addResult?.success) {
          friendAdded = addResult.friend?.username;
          // Ensure social window opens when user clicks "Continue"
          if (!pendingWindowAfterLogin) pendingWindowAfterLogin = 'social';
        }
      } catch { /* ignore */ }
      pendingInviteCode = null;
    }
    // Don't close loginWindow yet — let the renderer show the invite code panel.
    // The window closes when the user clicks "Continue" (triggers __continue__).
    return { success: true, inviteCode: result.inviteCode, friendAdded };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('social-sign-in', async (event, email, password) => {
  if (typeof email !== 'string') return { error: 'Invalid input' };
  // Special '__continue__' signal from the success panel
  if (email === '__continue__') {
    if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
    openPendingWindow();
    return { success: true };
  }

  try {
    await supabaseClient.signIn(email, password);
    await startSocialSync();
    // Process pending invite code from deep link (auto-add friend)
    if (pendingInviteCode && socialSync) {
      try {
        const addResult = await socialSync.addFriend(pendingInviteCode);
        if (addResult?.success) {
          // Ensure social window opens to show the new friend
          if (!pendingWindowAfterLogin) pendingWindowAfterLogin = 'social';
          if (Notification.isSupported()) {
            new Notification({
              title: 'Friend added!',
              body: `${addResult.friend?.username || 'New friend'} has been added.`,
              silent: false,
            }).show();
          }
        }
      } catch { /* ignore */ }
      pendingInviteCode = null;
    }
    if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
    openPendingWindow();
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('social-sign-out', async () => {
  try {
    if (socialSync) { socialSync.stop(); socialSync = null; }
    await supabaseClient.signOut();
    if (socialWindow && !socialWindow.isDestroyed()) socialWindow.close();
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('social-send-reset', async (event, email) => {
  if (typeof email !== 'string') return { error: 'Invalid input' };
  try {
    await supabaseClient.sendPasswordReset(email);
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('social-reset-password', async (event, email, otpCode, newPassword) => {
  if (typeof email !== 'string' || typeof otpCode !== 'string' || typeof newPassword !== 'string') {
    return { error: 'Invalid input' };
  }
  try {
    await supabaseClient.resetPassword(email, otpCode, newPassword);
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('social-is-logged-in', async () => {
  const user = await supabaseClient.getCurrentUser();
  return { loggedIn: !!user };
});

ipcMain.handle('social-get-profile', async () => {
  return await supabaseClient.getMyProfile();
});

ipcMain.handle('social-update-profile', async (event, updates) => {
  if (!updates || typeof updates !== 'object') return { error: 'Invalid input' };
  try {
    const profile = await supabaseClient.updateProfile(updates);
    return { success: true, profile };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('open-external-url', async (event, url) => {
  const { shell } = require('electron');
  // Only allow http/https URLs for safety
  if (url && (url.startsWith('https://') || url.startsWith('http://'))) {
    shell.openExternal(url);
  }
});

ipcMain.handle('social-add-friend', async (event, code) => {
  if (!socialSync) return { success: false, error: 'Not logged in' };
  if (typeof code !== 'string' || code.length > 20) return { success: false, error: 'Invalid code' };
  return await socialSync.addFriend(code);
});

ipcMain.handle('social-get-friends', async () => {
  if (!socialSync) return [];
  return await socialSync.getFriends();
});

ipcMain.handle('social-remove-friend', async (event, friendId) => {
  if (!socialSync) return;
  if (typeof friendId !== 'string') return;
  return await socialSync.removeFriend(friendId);
});

ipcMain.handle('social-friend-ranking', async (event, period) => {
  if (!socialSync) return [];
  const validPeriods = ['today', '7d', '30d', 'all'];
  return await socialSync.getFriendRanking(validPeriods.includes(period) ? period : 'all');
});

ipcMain.handle('social-global-ranking', async (event, period) => {
  if (!socialSync) return [];
  const validPeriods = ['today', '7d', '30d', 'all'];
  return await socialSync.getGlobalRanking(validPeriods.includes(period) ? period : 'all');
});

// Return locally-detected subscription tier + active session info for social fallback
ipcMain.handle('social-get-local-info', () => {
  // Start with the persisted tier from config (survives disconnections),
  // then override with the more recent value from real-usage.json if available.
  const cfg = loadConfig();
  const info = { subscriptionTier: cfg.lastKnownTier || 'pro', activeSessions: [] };

  // Read tier from saved usage data (may be more recent than config)
  try {
    const usageFile = require('path').join(require('os').homedir(), '.alldaypoke', 'real-usage.json');
    if (require('fs').existsSync(usageFile)) {
      const saved = JSON.parse(require('fs').readFileSync(usageFile, 'utf8'));
      if (saved.subscriptionTier) info.subscriptionTier = saved.subscriptionTier;
    }
  } catch {}

  // Get active session project names from session monitor
  if (sessionMonitor) {
    const sessions = sessionMonitor.getSessions();
    info.activeSessions = sessions.map(s => ({
      project: s.project || null,
      busy: s.busy || false,
    }));
  }

  return info;
});

// ── Poke: send / poll / forward ──────────────────────────────────────────

ipcMain.handle('social-send-poke', async (event, recipientId) => {
  if (!socialSync) return { success: false, error: 'Not logged in' };
  if (typeof recipientId !== 'string') return { success: false, error: 'Invalid recipient' };
  try {
    return await socialSync.sendPoke(recipientId);
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Self-poke: trigger the robot animation on the main widget
ipcMain.handle('trigger-self-poke', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('poke-received', { senderName: 'You' });
  }
  return { success: true };
});

// Poll for incoming pokes every 10 seconds — forward to main widget renderer
let pokePoller = null;

function startPokePolling() {
  if (pokePoller) return;
  pokePoller = setInterval(async () => {
    if (!socialSync) return;
    try {
      const pokes = await socialSync.getUnreadPokes();
      if (pokes.length > 0) {
        // Forward to main widget for head-pat animation
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('poke-received', pokes[0]);
        }
        // Show system notification
        if (Notification.isSupported()) {
          new Notification({
            title: 'Poke!',
            body: `${pokes[0].senderName} poked you!`,
            silent: false,
          }).show();
        }
        // Mark all as read
        const ids = pokes.map(p => p.id);
        await socialSync.markPokesRead(ids);
      }
    } catch (err) {
      // Silently ignore polling errors
    }
  }, 10000);
}

function stopPokePolling() {
  if (pokePoller) { clearInterval(pokePoller); pokePoller = null; }
}

// Context menu
ipcMain.handle('show-context-menu', (event) => {
  const template = [
    {
      label: '🔑 Claude Login',
      click: () => {
        if (!setupWindow) {
          // If the main window is already running, this is a re-auth
          createSetupWindow(mainWindow ? { reauth: true } : {});
        } else {
          setupWindow.focus();
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Reload',
      click: async () => {
        if (!mainWindow) return;

        // Reset auth failure state in the tracker so it retries immediately
        if (autoUsageUpdater && autoUsageUpdater.claudeTracker) {
          autoUsageUpdater.claudeTracker.consecutiveAuthFailures = 0;
          autoUsageUpdater.claudeTracker.authNeededEmitted = false;
          autoUsageUpdater.claudeTracker.cachedToken = null;
          autoUsageUpdater.claudeTracker.cachedTokenExpiresAt = 0;

          // Trigger an immediate usage check with fresh credentials
          autoUsageUpdater.claudeTracker.checkUsage().catch(() => {});
        }

        // Reload the renderer UI
        mainWindow.reload();
      }
    },
    {
      label: '🏆 Usage Ranking',
      click: () => {
        openRankingWindow();
      }
    },
    {
      label: '🌐 Social Ranking',
      click: async () => {
        let user = await supabaseClient.getCurrentUser();
        // If session was lost, try to restore it
        if (!user) {
          user = await supabaseClient.restoreSession();
        }
        if (user) {
          // Ensure social sync is running
          if (!socialSync) await startSocialSync();
          openSocialWindow();
        } else {
          pendingWindowAfterLogin = 'social';
          openLoginWindow();
        }
      }
    },
    { type: 'separator' },
    {
      label: updateState.status === 'available' ? `🔄 Update to v${updateState.version}` :
             updateState.status === 'downloading' ? `🔄 Downloading... ${updateState.progress}%` :
             updateState.status === 'downloaded' ? '🔄 Restart to Update' :
             '🔄 Check for Updates',
      click: () => {
        if (updateState.status === 'downloaded') {
          // Ready to install — quit and install
          if (updaterInstance) updaterInstance.quitAndInstall(false, true);
        } else if (updateState.status === 'available') {
          // Start download
          if (updaterInstance) updaterInstance.downloadUpdate().catch(() => {});
        } else {
          // Check for updates
          if (updaterInstance) {
            updaterInstance.checkForUpdates().catch(() => {});
          } else {
            checkForUpdatesManual();
          }
        }
      }
    },
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

// ── Deep link protocol: alldaypoke://invite/CODE ──────────────────────────

// Register the custom protocol (macOS: works after first launch sets the handler)
if (process.defaultApp) {
  // Dev mode: need to pass the app path
  app.setAsDefaultProtocolClient('alldaypoke', process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient('alldaypoke');
}

/**
 * Parse an alldaypoke:// URL and handle the invite flow.
 * - If logged in → add friend immediately
 * - If not logged in → store pendingInviteCode, open login; friend added after login
 */
async function handleDeepLink(url) {
  log('Deep link received:', url);

  // ── Invite: alldaypoke://invite/ABCD1234
  const match = url.match(/alldaypoke:\/\/invite\/([A-Za-z0-9]+)/);
  if (!match) return;

  const code = match[1].toUpperCase();
  log('Invite code from deep link:', code);

  const user = await supabaseClient.getCurrentUser();
  if (user && socialSync) {
    // Already logged in — add friend directly
    try {
      const result = await socialSync.addFriend(code);
      if (result?.success) {
        log('Friend added via deep link:', result.friend?.username);
        if (Notification.isSupported()) {
          new Notification({
            title: 'Friend added!',
            body: `${result.friend?.username || 'New friend'} has been added.`,
            silent: false,
          }).show();
        }
        // Open social window to show the result
        openSocialWindow();
      } else {
        log('Deep link add friend failed:', result?.error);
        if (Notification.isSupported()) {
          new Notification({
            title: 'Could not add friend',
            body: result?.error || 'Unknown error',
            silent: false,
          }).show();
        }
      }
    } catch (err) {
      log.error('Deep link addFriend error:', err.message);
    }
  } else {
    // Not logged in — queue the code and open login
    pendingInviteCode = code;
    pendingWindowAfterLogin = 'social'; // open social window after login to show new friend
    openLoginWindow();
  }
}

// macOS: app is already running, opened via URL
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

// Windows/Linux: second instance launched with URL arg
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (event, argv) => {
    // The URL is the last argument
    const url = argv.find(arg => arg.startsWith('alldaypoke://'));
    if (url) handleDeepLink(url);
    // Focus main window
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// Also check process.argv for URL on first launch
const launchUrl = process.argv.find(arg => arg.startsWith('alldaypoke://'));

// App event handlers
app.whenReady().then(() => {
  // Set dock icon to the robot (works in dev and packaged builds)
  if (process.platform === 'darwin' && app.dock) {
    const iconPath = path.join(__dirname, 'icon.png');
    if (fs.existsSync(iconPath)) {
      app.dock.setIcon(nativeImage.createFromPath(iconPath));
    }
  }

  // Handle deep link from launch args
  if (launchUrl) {
    // Defer until services are up
    setTimeout(() => handleDeepLink(launchUrl), 2000);
  }

  // Check if authentication exists
  if (!hasAuth()) {
    createSetupWindow();
  } else {
    createMainWindow();
  }

  // Auto-start on login for packaged builds
  if (app.isPackaged) {
    app.setLoginItemSettings({
      openAtLogin: true,
      openAsHidden: false,
    });
  }

  // Check for updates (silent, non-blocking)
  initAutoUpdater();
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

// Toggle click-through for transparent areas
ipcMain.handle('set-ignore-mouse-events', (event, ignore, opts) => {
  if (mainWindow) {
    if (ignore) {
      mainWindow.setIgnoreMouseEvents(true, { forward: true });
    } else {
      mainWindow.setIgnoreMouseEvents(false);
    }
  }
});

// Handle drag movement
ipcMain.handle('set-window-position', (event, pos) => {
  if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') return;
  if (!isFinite(pos.x) || !isFinite(pos.y)) return;
  if (mainWindow) {
    const config = loadConfig();
    if (!config.window_locked) {
      mainWindow.setPosition(Math.round(pos.x), Math.round(pos.y));
    }
  }
});

// Save robot scale from renderer
ipcMain.handle('save-robot-scale', (event, scale) => {
  if (typeof scale !== 'number' || !isFinite(scale)) return;
  const config = loadConfig();
  config.robot_scale = Math.max(0.3, Math.min(1.5, scale));
  saveConfig(config);
});
