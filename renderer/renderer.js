// Main renderer process script
let robot;
let stats;
let isDragging = false;
let dragStartX = 0;
let dragStartY = 0;
let windowStartX = 0;
let windowStartY = 0;

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  initializeRobot();
  initializeStats();
  setupEventListeners();
  setupIPC();
});

function initializeRobot() {
  const container = document.getElementById('robot-container');
  robot = new PixelRobot(container);

  // Set up blinking interval for idle state
  setInterval(() => {
    if (robot && robot.state === 'idle') {
      robot.blink();
    }
  }, 4000);
}

function initializeStats() {
  stats = new StatsDisplay();
}

function setupEventListeners() {
  const robotContainer = document.getElementById('robot-container');

  // Drag handling
  robotContainer.addEventListener('mousedown', handleDragStart);
  document.addEventListener('mousemove', handleDragMove);
  document.addEventListener('mouseup', handleDragEnd);

  // Context menu
  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    window.electronAPI.showContextMenu();
  });

  // Prevent text selection
  document.addEventListener('selectstart', (e) => {
    e.preventDefault();
  });
}

function handleDragStart(e) {
  if (e.button !== 0) return; // Only left click

  isDragging = true;
  dragStartX = e.screenX;
  dragStartY = e.screenY;

  // Get current window position
  const rect = document.body.getBoundingClientRect();
  windowStartX = window.screenX;
  windowStartY = window.screenY;

  document.body.classList.add('dragging');
  e.preventDefault();
}

function handleDragMove(e) {
  if (!isDragging) return;

  const deltaX = e.screenX - dragStartX;
  const deltaY = e.screenY - dragStartY;

  const newX = windowStartX + deltaX;
  const newY = windowStartY + deltaY;

  window.electronAPI.setWindowPosition({ x: newX, y: newY });
}

function handleDragEnd(e) {
  if (!isDragging) return;

  isDragging = false;
  document.body.classList.remove('dragging');
}

function setupIPC() {
  // Listen for token updates
  window.electronAPI.onTokenUpdate((data) => {
    if (stats) {
      stats.updateTokenUsage(data);
    }

    // Show demo mode indicator
    if (data.demo) {
      document.getElementById('widget-container').classList.add('demo-mode');
    }

    // Show error state
    if (data.error) {
      document.getElementById('widget-container').classList.add('error-state');
    } else {
      document.getElementById('widget-container').classList.remove('error-state');
    }
  });

  // Listen for state changes
  window.electronAPI.onStateChange((data) => {
    if (robot) {
      robot.setState(data.state);
    }

    // Update UI based on state
    if (data.state === 'active') {
      document.getElementById('token-percentage').classList.add('active');
    } else {
      document.getElementById('token-percentage').classList.remove('active');
    }
  });

  // Listen for reset countdown ticks
  window.electronAPI.onResetTick((data) => {
    if (stats) {
      stats.updateCountdown(data.timeLeft);
    }
  });

  // Listen for poke (pat-head animation)
  window.electronAPI.onPokeReceived((data) => {
    if (robot) {
      robot.patHead();
    }
  });

  // Listen for session updates
  window.electronAPI.onSessionUpdate((data) => {
    const sessionText = document.getElementById('session-text');
    if (!sessionText) return;

    if (data.count > 0) {
      // Build per-session display with busy/idle indicator
      const items = data.sessions.slice(0, 3).map(s => {
        const name = s.project || 'unknown';
        if (s.busy) {
          return `<span class="session-busy">${name}</span>`;
        }
        return `<span class="session-idle">${name}</span>`;
      });

      const dotClass = data.busyCount > 0 ? 'session-dot busy' : 'session-dot idle';
      const summary = data.busyCount > 0
        ? `${data.busyCount} running`
        : `${data.count} idle`;

      sessionText.innerHTML =
        `<span class="${dotClass}"></span>${summary}: ${items.join(', ')}`;
    } else {
      sessionText.innerHTML = '';
    }
  });
}

// Cleanup on window close
window.addEventListener('beforeunload', () => {
  window.electronAPI.removeAllListeners();
});