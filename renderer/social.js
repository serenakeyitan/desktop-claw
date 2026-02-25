// Social Ranking renderer script

let currentTab = 'friends';
let currentPeriod = 'today';
let myProfile = null;

document.addEventListener('DOMContentLoaded', () => {
  loadProfile();
  setupMainTabs();
  setupPeriodTabs();
  setupAddFriend();
  setupInviteModal();
  setupProfileModal();
  setupSignOut();
  loadData();
});

// ── Profile ─────────────────────────────────────────────────────────────────

async function loadProfile() {
  try {
    const profile = await window.socialAPI.getProfile();
    myProfile = profile;
    if (profile) {
      document.getElementById('username').textContent = profile.display_name || profile.username;
    }
  } catch (err) {
    console.error('Failed to load profile:', err);
  }
}

// ── Main Tabs ───────────────────────────────────────────────────────────────

function setupMainTabs() {
  const tabs = document.querySelectorAll('.main-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentTab = tab.dataset.tab;

      const rankingSection = document.getElementById('ranking-section');
      const statusSection = document.getElementById('status-section');
      const periodTabs = document.getElementById('period-tabs');

      if (currentTab === 'status') {
        rankingSection.classList.add('hidden');
        statusSection.classList.remove('hidden');
        periodTabs.classList.add('hidden');
      } else {
        rankingSection.classList.remove('hidden');
        statusSection.classList.add('hidden');
        periodTabs.classList.remove('hidden');
      }

      loadData();
    });
  });
}

// ── Period Tabs ─────────────────────────────────────────────────────────────

function setupPeriodTabs() {
  const tabs = document.querySelectorAll('.period-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentPeriod = tab.dataset.period;
      loadData();
    });
  });
}

// ── Load Data ───────────────────────────────────────────────────────────────

async function loadData() {
  if (currentTab === 'friends') {
    await loadFriendRanking();
  } else if (currentTab === 'global') {
    await loadGlobalRanking();
  } else if (currentTab === 'status') {
    await loadFriendStatus();
  }
}

async function loadFriendRanking() {
  const tableBody = document.getElementById('table-body');
  tableBody.innerHTML = '<div id="loading">Loading...</div>';

  try {
    let ranking = await window.socialAPI.getFriendRanking(currentPeriod);
    ranking = ranking || [];

    // If server returned empty, fall back to local data so the user always sees their own stats
    if (ranking.length === 0) {
      ranking = await buildLocalSelfRanking(currentPeriod);
    }

    renderRanking(ranking);
  } catch (err) {
    console.error('Failed to load friend ranking:', err);
    // Fall back to local data on error
    try {
      const fallback = await buildLocalSelfRanking(currentPeriod);
      renderRanking(fallback);
    } catch {
      tableBody.innerHTML = '<div class="empty-state">Failed to load ranking</div>';
    }
  }
}

async function loadGlobalRanking() {
  const tableBody = document.getElementById('table-body');
  tableBody.innerHTML = '<div id="loading">Loading...</div>';

  try {
    let ranking = await window.socialAPI.getGlobalRanking(currentPeriod);
    ranking = ranking || [];

    // If server returned empty, fall back to local data so user sees their own stats
    if (ranking.length === 0) {
      ranking = await buildLocalSelfRanking(currentPeriod);
    }

    renderRanking(ranking);
  } catch (err) {
    console.error('Failed to load global ranking:', err);
    // Fall back to local data on error
    try {
      const fallback = await buildLocalSelfRanking(currentPeriod);
      renderRanking(fallback);
    } catch {
      tableBody.innerHTML = '<div class="empty-state">Failed to load ranking</div>';
    }
  }
}

async function loadFriendStatus() {
  const statusList = document.getElementById('status-list');
  statusList.innerHTML = '<div id="loading">Loading...</div>';

  try {
    // Friend ranking with period='all' gives us status data
    let ranking = await window.socialAPI.getFriendRanking('all');
    ranking = ranking || [];

    // If server returned empty, fall back to local self
    if (ranking.length === 0) {
      ranking = await buildLocalSelfRanking('all');
    }

    renderStatusList(ranking);
  } catch (err) {
    console.error('Failed to load friend status:', err);
    // Fall back to local data on error
    try {
      const fallback = await buildLocalSelfRanking('all');
      renderStatusList(fallback);
    } catch {
      statusList.innerHTML = '<div class="empty-state">Failed to load status</div>';
    }
  }
}

// ── Render Ranking ──────────────────────────────────────────────────────────

function renderRanking(data) {
  const tableBody = document.getElementById('table-body');

  if (!data || data.length === 0) {
    tableBody.innerHTML = '<div class="empty-state">No data yet. Add friends and start coding!</div>';
    return;
  }

  // Compute estimated tokens for each user (used for bar width comparison)
  const estimatedTokens = data.map(item =>
    (item.total_usage || 0) / 100 * getTokensPerWindow(item.subscription_tier)
  );
  const maxTokens = estimatedTokens[0] || 1;
  const fragment = document.createDocumentFragment();

  data.forEach((item, index) => {
    const rank = index + 1;
    const row = document.createElement('div');
    row.className = `ranking-row${rank <= 3 ? ` rank-${rank}` : ''}`;

    const barWidth = maxTokens > 0 ? (estimatedTokens[index] / maxTokens) * 100 : 0;
    const isVibing = item.is_vibing;
    const timeStr = formatTime(item.total_time_ms || 0);
    const usageStr = formatUsage(item.total_usage || 0, item.subscription_tier);
    const sessions = item.log_count || 0;
    const project = item.current_project || '';

    const tierLabel = { pro: 'PRO', max_100: 'MAX', max_200: 'MAX+' }[item.subscription_tier] || '';

    // In ranking tabs: show "LIVE" or "last vibe Xm ago"
    const lastActive = item.last_active_at ? timeAgo(new Date(item.last_active_at)) : '';
    const vibingLabel = isVibing
      ? 'LIVE'
      : (lastActive ? lastActive : 'idle');

    // Show poke button for all users (including yourself)
    const showPoke = (currentTab === 'friends' || currentTab === 'global') && item.user_id;

    row.innerHTML = `
      <span class="col-rank">${rank}</span>
      <div class="user-cell col-user">
        <span class="display-name">${escapeHtml(item.display_name || item.username || '???')}${tierLabel ? ` <span class="tier-badge tier-${item.subscription_tier}">${tierLabel}</span>` : ''}${buildSocialIcons(item)}</span>
        <div class="user-bar"><div class="user-bar-fill" style="width: ${barWidth}%"></div></div>
      </div>
      <span class="col-usage"><span class="usage-val">${usageStr}</span></span>
      <span class="col-sessions">${sessions}</span>
      <span class="col-time">${timeStr}</span>
      <span class="col-vibing">
        <span class="vibing-dot ${isVibing ? 'online' : 'offline'}"></span>
        <span class="vibing-text ${isVibing ? 'active' : ''}">${vibingLabel}</span>
      </span>
      <span class="col-poke">${showPoke ? `<button class="poke-btn" data-uid="${item.user_id}" title="Poke ${escapeHtml(item.display_name || item.username)}">Poke</button>` : ''}</span>
    `;

    // Attach social icon click handlers
    attachSocialIconHandlers(row);

    // Attach poke handler
    if (showPoke) {
      const pokeBtn = row.querySelector('.poke-btn');
      pokeBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        pokeBtn.disabled = true;
        pokeBtn.textContent = '...';

        // Check isSelf at click time (myProfile may have loaded by now)
        const isSelf = item.user_id === 'self'
          || (myProfile && item.user_id === myProfile.id)
          || (myProfile && item.username === myProfile.username);

        // Self-poke: trigger robot animation, no server call
        if (isSelf) {
          window.socialAPI.triggerSelfPoke();
          pokeBtn.textContent = 'Poked!';
          pokeBtn.classList.add('poked');
          setTimeout(() => {
            pokeBtn.textContent = 'Poke';
            pokeBtn.classList.remove('poked');
            pokeBtn.disabled = false;
          }, 2000);
          return;
        }

        try {
          const res = await window.socialAPI.sendPoke(item.user_id);
          if (res.success) {
            pokeBtn.textContent = 'Poked!';
            pokeBtn.classList.add('poked');
            setTimeout(() => {
              pokeBtn.textContent = 'Poke';
              pokeBtn.classList.remove('poked');
              pokeBtn.disabled = false;
            }, 2000);
          } else {
            pokeBtn.textContent = 'Fail';
            setTimeout(() => { pokeBtn.textContent = 'Poke'; pokeBtn.disabled = false; }, 1500);
          }
        } catch {
          pokeBtn.textContent = 'Fail';
          setTimeout(() => { pokeBtn.textContent = 'Poke'; pokeBtn.disabled = false; }, 1500);
        }
      });
    }

    fragment.appendChild(row);
  });

  tableBody.innerHTML = '';
  tableBody.appendChild(fragment);
}

// ── Render Status List ──────────────────────────────────────────────────────

function renderStatusList(data) {
  const statusList = document.getElementById('status-list');

  if (!data || data.length === 0) {
    statusList.innerHTML = '<div class="empty-state">No friends yet. Share your invite code!</div>';
    return;
  }

  const fragment = document.createDocumentFragment();

  for (const item of data) {
    const card = document.createElement('div');
    card.className = 'status-card';

    const initial = (item.display_name || item.username || '?')[0].toUpperCase();
    const isVibing = item.is_vibing;
    const lastActive = item.last_active_at ? timeAgo(new Date(item.last_active_at)) : 'never';
    const project = item.current_project || '';

    card.innerHTML = `
      <div class="status-avatar">${initial}</div>
      <div class="status-info">
        <div class="status-name">${escapeHtml(item.display_name || item.username || '???')}${buildSocialIcons(item)}</div>
        <div class="status-detail ${isVibing ? 'vibing' : ''}">
          ${isVibing
            ? `Vibing${project ? ' on ' + escapeHtml(project) : ''}`
            : `Last active ${lastActive}`
          }
        </div>
      </div>
      <span class="status-badge ${isVibing ? 'vibing' : 'idle'}">
        ${isVibing ? 'VIBING' : 'IDLE'}
      </span>
    `;

    attachSocialIconHandlers(card);
    fragment.appendChild(card);
  }

  statusList.innerHTML = '';
  statusList.appendChild(fragment);
}

// ── Add Friend ──────────────────────────────────────────────────────────────

function setupAddFriend() {
  const btn = document.getElementById('add-friend-btn');
  const input = document.getElementById('friend-code-input');
  const result = document.getElementById('friend-result');

  btn.addEventListener('click', async () => {
    const code = input.value.trim().toUpperCase();
    if (!code) return;

    result.classList.add('hidden');
    btn.disabled = true;
    btn.textContent = 'Adding...';

    try {
      const res = await window.socialAPI.addFriend(code);
      if (res.success) {
        result.textContent = `Added ${res.friend?.username || 'friend'}!`;
        result.className = 'success';
        result.classList.remove('hidden');
        input.value = '';
        loadData(); // refresh
      } else {
        result.textContent = res.error || 'Failed to add friend';
        result.className = 'error';
        result.classList.remove('hidden');
      }
    } catch (err) {
      result.textContent = err.message || 'Failed to add friend';
      result.className = 'error';
      result.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Add Friend';
    }
  });

  input.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') btn.click();
  });
}

// ── Invite Modal ────────────────────────────────────────────────────────────

function setupInviteModal() {
  const modal = document.getElementById('invite-modal');
  const inviteBtn = document.getElementById('invite-btn');
  const closeBtn = document.getElementById('modal-close-btn');
  const copyBtn = document.getElementById('modal-copy-btn');

  inviteBtn.addEventListener('click', async () => {
    if (!myProfile) await loadProfile();
    if (myProfile?.invite_code) {
      const link = `https://serenakeyitan.github.io/desktop-claw/invite/?code=${myProfile.invite_code}`;
      document.getElementById('modal-invite-link').textContent = link;
    }
    modal.classList.remove('hidden');
  });

  closeBtn.addEventListener('click', () => {
    modal.classList.add('hidden');
  });

  copyBtn.addEventListener('click', () => {
    const link = document.getElementById('modal-invite-link').textContent;
    navigator.clipboard.writeText(link).then(() => {
      copyBtn.textContent = 'Copied!';
      setTimeout(() => { copyBtn.textContent = 'Copy Link'; }, 2000);
    });
  });

  // Close on backdrop click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.classList.add('hidden');
  });
}

// ── Profile Settings Modal ───────────────────────────────────────────────

function setupProfileModal() {
  const modal = document.getElementById('profile-modal');
  const closeBtn = document.getElementById('profile-close-btn');
  const saveBtn = document.getElementById('profile-save-btn');
  const editBtn = document.getElementById('edit-profile-btn');

  // Click "Edit" button to open profile settings
  editBtn.addEventListener('click', async () => {
    if (!myProfile) await loadProfile();
    if (myProfile) {
      document.getElementById('profile-display-name').value = myProfile.display_name || '';
      document.getElementById('profile-twitter').value = myProfile.twitter_username || '';
      document.getElementById('profile-github').value = myProfile.github_username || '';
    }
    document.getElementById('profile-result').classList.add('hidden');
    modal.classList.remove('hidden');
  });

  closeBtn.addEventListener('click', () => modal.classList.add('hidden'));
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.classList.add('hidden');
  });

  saveBtn.addEventListener('click', async () => {
    const resultEl = document.getElementById('profile-result');
    resultEl.classList.add('hidden');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    const updates = {
      display_name: document.getElementById('profile-display-name').value.trim(),
      twitter_username: document.getElementById('profile-twitter').value.trim().replace(/^@/, ''),
      github_username: document.getElementById('profile-github').value.trim().replace(/^@/, ''),
    };

    try {
      const res = await window.socialAPI.updateProfile(updates);
      if (res.error) {
        resultEl.textContent = res.error;
        resultEl.className = 'error';
        resultEl.classList.remove('hidden');
      } else {
        resultEl.textContent = 'Profile saved!';
        resultEl.className = 'success';
        resultEl.classList.remove('hidden');
        myProfile = res.profile || { ...myProfile, ...updates };
        document.getElementById('username').textContent = myProfile.display_name || myProfile.username;
        // Refresh ranking to show updated social icons
        loadData();
        setTimeout(() => modal.classList.add('hidden'), 1000);
      }
    } catch (err) {
      resultEl.textContent = err.message || 'Failed to save';
      resultEl.className = 'error';
      resultEl.classList.remove('hidden');
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
    }
  });
}

// ── Sign Out ────────────────────────────────────────────────────────────────

function setupSignOut() {
  document.getElementById('signout-btn').addEventListener('click', async () => {
    try {
      await window.socialAPI.signOut();
      // Main process will handle closing the window
    } catch (err) {
      console.error('Sign-out failed:', err);
    }
  });
}

// ── Local Fallback ──────────────────────────────────────────────────────────

/**
 * Build a self-ranking row from local usage data + profile.
 * Used as fallback when the server returns empty (e.g., no friends, network error).
 * Aggregates all local projects into a single row for the current user.
 */
async function buildLocalSelfRanking(period) {
  try {
    // Fetch all three sources in parallel, but don't let any single failure break the whole thing
    const [localData, profile, localInfo] = await Promise.all([
      window.socialAPI.getLocalRanking(period).catch(() => null),
      myProfile ? Promise.resolve(myProfile) : window.socialAPI.getProfile().catch(() => null),
      window.socialAPI.getLocalInfo().catch(() => null),
    ]);

    const total = localData?.total || {};

    // Use locally-detected tier (from real-usage.json) over profile tier,
    // since profile tier may still be the default 'pro' before first sync
    const tier = localInfo?.subscriptionTier || profile?.subscription_tier || 'pro';

    // Get active session project names
    const sessions = localInfo?.activeSessions || [];
    const projectNames = sessions.map(s => s.project).filter(Boolean);
    const projectStr = projectNames.join(', ') || null;
    const isVibing = sessions.length > 0;

    // Always return at least a self row — never return empty
    return [{
      user_id: 'self',
      username: profile?.username || 'You',
      display_name: profile?.display_name || profile?.username || 'You',
      subscription_tier: tier,
      twitter_username: profile?.twitter_username || null,
      github_username: profile?.github_username || null,
      total_usage: total.totalDelta || 0,
      total_time_ms: total.totalTimeMs || 0,
      log_count: localData?.ranking?.reduce((sum, r) => sum + (r.sessionCount || 0), 0) || 0,
      is_vibing: isVibing,
      current_project: projectStr,
      last_active_at: new Date().toISOString(),
    }];
  } catch (err) {
    console.error('buildLocalSelfRanking failed:', err);
    // Even on total failure, return a minimal self row
    return [{
      user_id: 'self',
      username: 'You',
      display_name: 'You',
      subscription_tier: 'pro',
      total_usage: 0,
      total_time_ms: 0,
      log_count: 0,
      is_vibing: false,
      current_project: null,
      last_active_at: new Date().toISOString(),
    }];
  }
}

// ── Social Icons Helper ──────────────────────────────────────────────────────

function buildSocialIcons(item) {
  let html = '';
  if (item.twitter_username || item.github_username) {
    html += '<span class="social-icons">';
    if (item.twitter_username) {
      html += `<span class="social-icon-link twitter-icon" data-url="https://x.com/${encodeURIComponent(item.twitter_username)}" title="@${escapeHtml(item.twitter_username)} on X">\ud835\udd4f</span>`;
    }
    if (item.github_username) {
      html += `<span class="social-icon-link github-icon" data-url="https://github.com/${encodeURIComponent(item.github_username)}" title="${escapeHtml(item.github_username)} on GitHub"><svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg></span>`;
    }
    html += '</span>';
  }
  return html;
}

function attachSocialIconHandlers(container) {
  container.querySelectorAll('.social-icon-link').forEach(icon => {
    icon.addEventListener('click', (e) => {
      e.stopPropagation();
      const url = icon.dataset.url;
      if (url) window.socialAPI.openExternal(url);
    });
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

// Estimate tokens from utilization percentage.
// total_usage is the cumulative percentage-point delta, so
// 100% = one full 5-hour window.  The token budget per window
// differs by subscription tier.
const TOKENS_BY_TIER = {
  pro:     5_000_000,   //  ~5M tokens per 5-hour window (Claude Pro)
  max_100: 45_000_000,  // ~45M tokens per 5-hour window (Claude Max $100)
  max_200: 90_000_000,  // ~90M tokens per 5-hour window (Claude Max $200)
};

function getTokensPerWindow(tier) {
  return TOKENS_BY_TIER[tier] || TOKENS_BY_TIER.pro;
}

function formatUsage(totalPercent, tier) {
  if (!totalPercent || totalPercent <= 0) return '0';
  const tokensPerWindow = getTokensPerWindow(tier);
  const tokens = (totalPercent / 100) * tokensPerWindow;
  return formatTokens(tokens);
}

function formatTokens(tokens) {
  if (tokens >= 1_000_000_000) return `${(tokens / 1_000_000_000).toFixed(1)}B`;
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}K`;
  return `${Math.round(tokens)}`;
}

function formatTime(ms) {
  if (!ms || ms <= 0) return '0m';
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return '<1m';
}

function timeAgo(date) {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ── Auto-refresh every 30 seconds ───────────────────────────────────────────
setInterval(() => { loadData(); }, 30000);
