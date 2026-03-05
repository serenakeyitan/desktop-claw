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
  setupUpdateListener();
  setupOnboarding();
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

  // Force a repaint shortly after creation — workaround for macOS
  // transparent window sometimes not rendering SVG content on first paint.
  requestAnimationFrame(() => {
    container.style.opacity = '0.99';
    requestAnimationFrame(() => {
      container.style.opacity = '1';
    });
  });

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

  // ── Click-through: only catch mouse on visible elements ──
  // When mouse is over transparent area → ignore (click-through to desktop)
  // When mouse is over robot/bubble → capture events
  setupClickThrough();
}

function setupClickThrough() {
  let isMouseOverContent = false;
  const bubble = document.getElementById('bubble');
  const robotContainer = document.getElementById('robot-container');

  // Check if mouse is over the robot body (the only primary hit target)
  function isOverRobot(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === document.body || el === document.documentElement) return false;

    // Robot container or anything inside it (SVG pixels, resize handle)
    if (robotContainer && robotContainer.contains(el)) return true;
    // Poke overlay elements (hand, msg, hearts) — positioned outside robot
    if (el.closest && (el.closest('.poke-hand') || el.closest('.poke-msg'))) return true;
    return false;
  }

  // Check if mouse is over the visible bubble (only when it's shown)
  function isOverBubble(e) {
    if (!bubble || !bubble.classList.contains('visible')) return false;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    return el && bubble.contains(el);
  }

  function isOverOnboarding(e) {
    if (!onboardingEl) return false;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    return el && onboardingEl.contains(el);
  }

  function isOverUpdatePopup(e) {
    const popup = document.getElementById('update-popup');
    if (!popup || popup.classList.contains('hidden')) return false;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    return el && popup.contains(el);
  }

  document.addEventListener('mousemove', (e) => {
    const overRobot = isOverRobot(e);
    const overBubble = isOverBubble(e);
    const overOnboarding = isOverOnboarding(e);
    const overUpdatePopup = isOverUpdatePopup(e);
    const overContent = overRobot || overBubble || overOnboarding || overUpdatePopup;

    // Toggle bubble visibility: show only when hovering robot or bubble itself
    if (bubble) {
      if (overRobot || overBubble) {
        bubble.classList.add('visible');
      } else {
        bubble.classList.remove('visible');
      }
    }

    // Toggle click-through
    if (overContent && !isMouseOverContent) {
      isMouseOverContent = true;
      window.electronAPI.setIgnoreMouseEvents(false);
    } else if (!overContent && isMouseOverContent && !isDragging && !isResizing) {
      isMouseOverContent = false;
      window.electronAPI.setIgnoreMouseEvents(true);
    }
  });

  document.addEventListener('mouseleave', () => {
    if (!isDragging && !isResizing) {
      isMouseOverContent = false;
      window.electronAPI.setIgnoreMouseEvents(true);
    }
    if (bubble) bubble.classList.remove('visible');
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

  // Re-check if we should go back to click-through mode
  // (mouse may have moved off the robot during drag)
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
    // Expose scale so robot.js can counter-scale poke overlays
    container.dataset.scale = robotScale;
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

    // Show auth-needed indicator (login retry detection)
    if (data.authNeeded) {
      document.getElementById('widget-container').classList.add('auth-needed');
    }
  });

  // Listen for auth recovery (login retry detection cleared)
  window.electronAPI.onAuthRecovered(() => {
    document.getElementById('widget-container').classList.remove('auth-needed');
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
      // Sort busy first, then alphabetically
      const sorted = [...data.sessions].sort((a, b) => {
        if (b.busy !== a.busy) return (b.busy ? 1 : 0) - (a.busy ? 1 : 0);
        return (a.project || '').localeCompare(b.project || '');
      });
      const shown = sorted.slice(0, 5);
      const busyCount = data.busyCount || 0;

      // Busy sessions highlighted, idle sessions dimmed
      const items = shown.map(s => {
        // Use project name, or derive from cwd, or fall back to 'session'
        const name = s.project
          || (s.cwd ? s.cwd.split('/').filter(Boolean).pop() : null)
          || 'session';
        const cls = s.busy ? 'session-active' : 'session-idle';
        return `<span class="${cls}">${name}</span>`;
      });

      const extra = data.count > shown.length ? ` +${data.count - shown.length}` : '';
      // Count only reflects running sessions
      const summary = busyCount > 0 ? `${busyCount} running` : 'idle';

      sessionText.innerHTML =
        `<span class="session-dot ${busyCount > 0 ? 'busy' : 'idle'}"></span>${summary}: ${items.join(', ')}${extra}`;

      // Robot active only when sessions are busy
      if (robot) {
        robot.setState(busyCount > 0 ? 'active' : 'idle');
      }
    } else {
      sessionText.innerHTML = '';
      if (robot) {
        robot.setState('idle');
      }
    }
  });
}

// ── Update popup ────────────────────────────────────────────────────────

let updatePopupDismissed = false;  // Track if user dismissed the popup this session

function setupUpdateListener() {
  const popup = document.getElementById('update-popup');
  const message = document.getElementById('update-message');
  const version = document.getElementById('update-version');
  const progressBar = document.getElementById('update-progress-bar');
  const progressFill = document.getElementById('update-progress-fill');
  const updateBtn = document.getElementById('update-btn');
  const dismissBtn = document.getElementById('update-dismiss');

  window.electronAPI.onUpdateStatus((data) => {
    switch (data.status) {
      case 'available':
        if (!updatePopupDismissed) {
          message.textContent = 'New version available!';
          version.textContent = `v${data.version}`;
          progressBar.classList.add('hidden');
          updateBtn.textContent = 'Update';
          updateBtn.className = '';
          dismissBtn.style.display = '';
          popup.classList.remove('hidden');
        }
        break;

      case 'downloading':
        message.textContent = 'Downloading update...';
        progressBar.classList.remove('hidden');
        progressFill.style.width = `${data.progress}%`;
        updateBtn.textContent = `${data.progress}%`;
        updateBtn.disabled = true;
        dismissBtn.style.display = 'none';
        popup.classList.remove('hidden');
        break;

      case 'downloaded':
        message.textContent = 'Update ready!';
        progressBar.classList.add('hidden');
        updateBtn.textContent = 'Restart';
        updateBtn.className = 'restart';
        updateBtn.disabled = false;
        dismissBtn.style.display = 'none';
        popup.classList.remove('hidden');
        break;

      case 'not-available':
      case 'error':
      case 'idle':
        // Hide popup unless it's already hidden
        if (!popup.classList.contains('hidden')) {
          popup.classList.add('hidden');
        }
        break;
    }
  });

  updateBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const status = updateBtn.textContent;
    if (status === 'Restart') {
      window.electronAPI.installUpdate();
    } else if (status === 'Update') {
      window.electronAPI.downloadUpdate();
    }
  });

  dismissBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    updatePopupDismissed = true;
    popup.classList.add('hidden');
  });
}

// ── Onboarding flow ──────────────────────────────────────────────────────

const ONBOARDING_STEPS = [
  {
    label: 'Your Robot',
    text: 'This is your usage buddy. Hover to see live stats, drag to move, right-click for the menu.',
    position: 'above',
  },
  {
    label: 'Social',
    text: 'Right-click and open Social Ranking to compete with friends and see who vibes the hardest.',
    position: 'above',
  },
];

let onboardingStep = 0;
let onboardingEl = null;

function startOnboarding() {
  onboardingStep = 0;
  showOnboardingStep();
}

function showOnboardingStep() {
  // Remove previous tooltip
  if (onboardingEl) {
    onboardingEl.remove();
    onboardingEl = null;
  }

  if (onboardingStep >= ONBOARDING_STEPS.length) {
    // Done — notify main process
    window.electronAPI.onboardingDone();
    return;
  }

  const step = ONBOARDING_STEPS[onboardingStep];
  const container = document.getElementById('widget-container');

  const tooltip = document.createElement('div');
  tooltip.id = 'onboarding-tooltip';
  tooltip.classList.add(step.position);

  // Build dots
  const dots = ONBOARDING_STEPS.map((_, i) =>
    `<span class="dot${i <= onboardingStep ? ' active' : ''}"></span>`
  ).join('');

  const isLast = onboardingStep === ONBOARDING_STEPS.length - 1;

  tooltip.innerHTML = `
    <div id="onboarding-step">${step.label}</div>
    <div id="onboarding-text">${step.text}</div>
    <div id="onboarding-actions">
      <div id="onboarding-dots">${dots}</div>
      <button id="onboarding-next">${isLast ? 'Got it' : 'Next'}</button>
    </div>
    <div id="onboarding-skip">skip</div>
    <div id="onboarding-tail"></div>
  `;

  container.appendChild(tooltip);
  onboardingEl = tooltip;

  // Make sure we capture mouse events on the tooltip
  window.electronAPI.setIgnoreMouseEvents(false);

  tooltip.querySelector('#onboarding-next').addEventListener('click', (e) => {
    e.stopPropagation();
    onboardingStep++;
    showOnboardingStep();
  });

  tooltip.querySelector('#onboarding-skip').addEventListener('click', (e) => {
    e.stopPropagation();
    // Skip straight to done
    if (onboardingEl) {
      onboardingEl.remove();
      onboardingEl = null;
    }
    window.electronAPI.onboardingDone();
  });
}

function setupOnboarding() {
  window.electronAPI.onStartOnboarding(() => {
    startOnboarding();
  });
}

// Cleanup on window close
window.addEventListener('beforeunload', () => {
  window.electronAPI.removeAllListeners();
});