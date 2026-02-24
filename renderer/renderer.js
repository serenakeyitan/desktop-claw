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

async function initializeRobot() {
  const container = document.getElementById('robot-container');
  robot = new PixelRobot(container);

  // Load saved robot scale from config
  try {
    const config = await window.electronAPI.getConfig();
    if (config && typeof config.robot_scale === 'number') {
      applyRobotScale(config.robot_scale);
    } else {
      applyRobotScale(0.6);
    }
  } catch (e) {
    applyRobotScale(0.6);
  }

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

  // Resize handle
  const resizeHandle = document.getElementById('resize-handle');
  if (resizeHandle) {
    resizeHandle.addEventListener('mousedown', handleResizeStart);
  }

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
  if (!isDragging || isResizing) return;

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

// ── Robot scale handling ──
let isResizing = false;
let resizeStartY = 0;
let resizeStartScale = 1;
let robotScale = 0.6; // default, overridden by config on load

function applyRobotScale(scale) {
  robotScale = Math.max(0.3, Math.min(1.5, scale));
  const container = document.getElementById('robot-container');
  if (container) {
    container.style.transform = `scale(${robotScale})`;
  }
  // Keep bubble sitting just above the visible robot
  // Robot container is 64px tall, transform-origin is center bottom
  // so visible top = bottom + (64 * scale). Add padding (10) + gap (6).
  const bubble = document.getElementById('bubble');
  if (bubble) {
    const visibleHeight = 64 * robotScale;
    bubble.style.bottom = `${visibleHeight + 16}px`;
  }
}

function handleResizeStart(e) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();

  isResizing = true;
  resizeStartY = e.screenY;
  resizeStartScale = robotScale;

  document.addEventListener('mousemove', handleResizeMove);
  document.addEventListener('mouseup', handleResizeEnd);
}

function handleResizeMove(e) {
  if (!isResizing) return;

  // Drag down = bigger, drag up = smaller
  const deltaY = e.screenY - resizeStartY;
  const newScale = resizeStartScale + deltaY * 0.005;
  applyRobotScale(newScale);
}

function handleResizeEnd(e) {
  if (!isResizing) return;
  isResizing = false;
  document.removeEventListener('mousemove', handleResizeMove);
  document.removeEventListener('mouseup', handleResizeEnd);
  // Persist
  window.electronAPI.saveRobotScale(robotScale);
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
      robot.patHead(data?.senderName);
    }
  });

  // Listen for session updates
  window.electronAPI.onSessionUpdate((data) => {
    const sessionText = document.getElementById('session-text');
    if (!sessionText) return;

    if (data.count > 0) {
      // Sort busy first, then show up to 3
      const sorted = [...data.sessions].sort((a, b) => (b.busy ? 1 : 0) - (a.busy ? 1 : 0));
      const shown = sorted.slice(0, 3);
      const shownBusy = shown.filter(s => s.busy).length;

      const items = shown.map(s => {
        const name = s.project || 'unknown';
        if (s.busy) {
          return `<span class="session-busy">${name}</span>`;
        }
        return `<span class="session-idle">${name}</span>`;
      });

      const dotClass = shownBusy > 0 ? 'session-dot busy' : 'session-dot idle';
      const summary = shownBusy > 0
        ? `${shownBusy} running`
        : `${shown.length} idle`;

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