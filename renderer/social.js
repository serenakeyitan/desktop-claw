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
  setupContextMenu();
  setupSignOut();
  setupMap();
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
      const mapSection = document.getElementById('map-section');
      const periodTabs = document.getElementById('period-tabs');

      rankingSection.classList.add('hidden');
      statusSection.classList.add('hidden');
      mapSection.classList.add('hidden');
      periodTabs.classList.add('hidden');

      if (currentTab === 'status') {
        statusSection.classList.remove('hidden');
      } else if (currentTab === 'map') {
        mapSection.classList.remove('hidden');
      } else {
        rankingSection.classList.remove('hidden');
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
  } else if (currentTab === 'map') {
    await loadMapData();
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
      tableBody.innerHTML = '<div class="empty-state-rich"><div class="empty-icon">~</div><div class="empty-title">Could not load rankings</div><div class="empty-hint">Check your connection and try again in a moment.</div></div>';
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
      tableBody.innerHTML = '<div class="empty-state-rich"><div class="empty-icon">~</div><div class="empty-title">Could not load rankings</div><div class="empty-hint">Check your connection and try again in a moment.</div></div>';
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
      statusList.innerHTML = '<div class="empty-state-rich"><div class="empty-icon">~</div><div class="empty-title">Could not load status</div><div class="empty-hint">Check your connection and try again in a moment.</div></div>';
    }
  }
}

// ── Render Ranking ──────────────────────────────────────────────────────────

function renderRanking(data) {
  const tableBody = document.getElementById('table-body');
  const rankBanner = document.getElementById('your-rank-banner');

  // Hide banner by default
  rankBanner.classList.add('hidden');
  rankBanner.innerHTML = '';

  if (!data || data.length === 0) {
    const isGlobal = currentTab === 'global';
    const emptyMsg = isGlobal
      ? '<div class="empty-state-rich">' +
        '<div class="empty-icon">~</div>' +
        '<div class="empty-title">No rankings yet</div>' +
        '<div class="empty-hint">Start a Claude Code session and your usage will appear here.</div>' +
        '</div>'
      : '<div class="empty-state-rich">' +
        '<div class="empty-icon">~</div>' +
        '<div class="empty-title">No friends yet</div>' +
        '<div class="empty-hint">Share your invite code to add friends and compete on usage.</div>' +
        '</div>';
    tableBody.innerHTML = emptyMsg;
    return;
  }

  // Use total_tokens from the server (per-row tier conversion) or local fallback.
  // Only fall back to client-side conversion for old server responses that
  // don't include total_tokens yet (before the SQL migration runs).
  const estimatedTokens = data.map(item =>
    item.total_tokens != null && item.total_tokens > 0
      ? item.total_tokens
      : (item.total_usage || 0) / 100 * getTokensPerWindow(item.subscription_tier)
  );
  const maxTokens = estimatedTokens[0] || 1;
  const fragment = document.createDocumentFragment();

  // Find the current user's index in the ranking
  let selfIndex = -1;

  data.forEach((item, index) => {
    const rank = index + 1;

    // Detect if this is the current user
    const isSelf = item.user_id === 'self'
      || (myProfile && item.user_id === myProfile.id)
      || (myProfile && item.username === myProfile.username);

    if (isSelf) selfIndex = index;

    const row = document.createElement('div');
    row.className = `ranking-row${rank <= 3 ? ` rank-${rank}` : ''}${isSelf ? ' self-row' : ''}`;
    if (isSelf) row.id = 'self-ranking-row';

    const barWidth = maxTokens > 0 ? (estimatedTokens[index] / maxTokens) * 100 : 0;
    const isVibing = item.is_vibing;
    const timeStr = formatTime(item.total_time_ms || 0);
    const usageStr = formatTokens(estimatedTokens[index]);
    const sessions = item.log_count || 0;
    const project = item.current_project || '';

    const baseTierLabel = { pro: 'PRO', max_100: 'MAX', max_200: 'MAX+' }[item.subscription_tier] || '';
    // Show "API" prefix for users connected via API key (not Claude OAuth)
    const isApiUser = item.auth_method && item.auth_method !== 'claude-oauth' && item.auth_method !== 'claude-status';
    const tierLabel = baseTierLabel ? (isApiUser ? `API ${baseTierLabel}` : baseTierLabel) : (isApiUser ? 'API' : '');

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

    // Attach right-click context menu for removing friends
    if (item.user_id && window._showFriendContextMenu) {
      row.addEventListener('contextmenu', (e) => {
        window._showFriendContextMenu(e, item.user_id, item.display_name || item.username);
      });
    }

    // Attach poke handler
    if (showPoke) {
      const pokeBtn = row.querySelector('.poke-btn');
      pokeBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        pokeBtn.disabled = true;
        pokeBtn.textContent = '...';

        // Check isSelf at click time (myProfile may have loaded by now)
        const clickIsSelf = item.user_id === 'self'
          || (myProfile && item.user_id === myProfile.id)
          || (myProfile && item.username === myProfile.username);

        // Self-poke: trigger robot animation, no server call
        if (clickIsSelf) {
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

  // Show "You are ranked #X" banner
  if (selfIndex >= 0) {
    const selfRank = selfIndex + 1;
    const totalCount = data.length;
    const tabLabel = currentTab === 'friends' ? 'among friends' : 'globally';
    rankBanner.innerHTML = `
      <span class="rank-label">You are ranked</span>
      <span class="rank-number">#${selfRank}</span>
      <span class="rank-label">of ${totalCount} ${tabLabel}</span>
      <button class="scroll-to-me" id="scroll-to-me-btn">Show me</button>
    `;
    rankBanner.classList.remove('hidden');

    // "Show me" button scrolls to self row
    document.getElementById('scroll-to-me-btn').addEventListener('click', () => {
      const selfRow = document.getElementById('self-ranking-row');
      if (selfRow) {
        selfRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // Brief flash effect
        selfRow.style.transition = 'background 0.3s';
        selfRow.style.background = 'rgba(205, 127, 93, 0.15)';
        setTimeout(() => { selfRow.style.background = ''; }, 1000);
      }
    });
  }
}

// ── Render Status List ──────────────────────────────────────────────────────

function renderStatusList(data) {
  const statusList = document.getElementById('status-list');

  if (!data || data.length === 0) {
    statusList.innerHTML =
      '<div class="empty-state-rich">' +
      '<div class="empty-icon">~</div>' +
      '<div class="empty-title">No friends yet</div>' +
      '<div class="empty-hint">Click "Invite" above to get your invite link, then share it with friends.</div>' +
      '</div>';
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

    // Attach right-click context menu for removing friends
    if (item.user_id && window._showFriendContextMenu) {
      card.addEventListener('contextmenu', (e) => {
        window._showFriendContextMenu(e, item.user_id, item.display_name || item.username);
      });
    }

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

  const copyCodeBtn = document.getElementById('modal-copy-code-btn');

  inviteBtn.addEventListener('click', async () => {
    if (!myProfile) await loadProfile();
    if (myProfile?.invite_code) {
      const link = `https://serenakeyitan.github.io/desktop-claw/invite/?code=${myProfile.invite_code}`;
      document.getElementById('modal-invite-link').textContent = link;
      document.getElementById('modal-invite-code').textContent = myProfile.invite_code;
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

  copyCodeBtn.addEventListener('click', () => {
    const code = document.getElementById('modal-invite-code').textContent;
    navigator.clipboard.writeText(code).then(() => {
      copyCodeBtn.textContent = 'Copied!';
      setTimeout(() => { copyCodeBtn.textContent = 'Copy Code'; }, 2000);
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
    const authMethod = localInfo?.authMethod || profile?.auth_method || 'claude-oauth';

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
      auth_method: authMethod,
      twitter_username: profile?.twitter_username || null,
      github_username: profile?.github_username || null,
      total_usage: total.totalDelta || 0,
      total_tokens: total.totalTokens || 0,
      total_time_ms: total.totalTimeMs || 0,
      log_count: localData?.ranking?.reduce((sum, r) => sum + (r.sessionCount || 0), 0) || 0,
      is_vibing: isVibing,
      current_project: projectStr,
      last_active_at: new Date().toISOString(),
    }];
  } catch (err) {
    console.error('buildLocalSelfRanking failed:', err);
    // Even on total failure, return a minimal self row.
    // Try to read the persisted tier so we don't show 'PRO' to Max users.
    let fallbackTier = 'pro';
    let fallbackAuth = 'claude-oauth';
    try {
      const li = await window.socialAPI.getLocalInfo().catch(() => null);
      if (li?.subscriptionTier) fallbackTier = li.subscriptionTier;
      if (li?.authMethod) fallbackAuth = li.authMethod;
    } catch { /* ignore */ }
    return [{
      user_id: 'self',
      username: 'You',
      display_name: 'You',
      subscription_tier: fallbackTier,
      auth_method: fallbackAuth,
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

// ── Context Menu (right-click to remove friend) ──────────────────────────────

function setupContextMenu() {
  const menu = document.getElementById('context-menu');
  const removeItem = document.getElementById('ctx-remove-friend');
  let targetUserId = null;
  let targetUsername = null;

  // Close menu on any click or escape
  document.addEventListener('click', () => menu.classList.add('hidden'));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') menu.classList.add('hidden');
  });

  // Remove friend handler
  removeItem.addEventListener('click', async (e) => {
    e.stopPropagation();
    menu.classList.add('hidden');

    if (!targetUserId) return;

    // Don't allow removing yourself
    const isSelf = targetUserId === 'self'
      || (myProfile && targetUserId === myProfile.id);
    if (isSelf) return;

    try {
      await window.socialAPI.removeFriend(targetUserId);
      loadData(); // refresh
    } catch (err) {
      console.error('Failed to remove friend:', err);
    }
  });

  // Expose a function to show the context menu for a given user
  window._showFriendContextMenu = function(e, userId, username) {
    // Don't show for yourself
    const isSelf = userId === 'self'
      || (myProfile && userId === myProfile.id);
    if (isSelf) return;

    // Only show on friends tab
    if (currentTab !== 'friends' && currentTab !== 'status') return;

    e.preventDefault();
    targetUserId = userId;
    targetUsername = username;

    // Position the menu at cursor
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;

    // Keep menu within viewport
    menu.classList.remove('hidden');
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      menu.style.left = `${window.innerWidth - rect.width - 4}px`;
    }
    if (rect.bottom > window.innerHeight) {
      menu.style.top = `${window.innerHeight - rect.height - 4}px`;
    }
  };
}

// ── World Map ────────────────────────────────────────────────────────────────

// Simplified world map coastline paths (Mercator-projected, normalized 0–1)
// Each sub-array is a polygon: [[x,y], [x,y], ...]
const WORLD_COASTLINES = [
  // North America
  [[0.05,0.18],[0.08,0.15],[0.12,0.12],[0.15,0.10],[0.18,0.12],[0.21,0.15],[0.24,0.14],[0.27,0.16],[0.29,0.20],[0.28,0.24],[0.26,0.28],[0.23,0.30],[0.20,0.33],[0.18,0.36],[0.16,0.38],[0.14,0.40],[0.12,0.42],[0.11,0.44],[0.13,0.46],[0.15,0.44],[0.17,0.42],[0.19,0.40],[0.21,0.38],[0.24,0.36],[0.26,0.38],[0.25,0.40],[0.23,0.42],[0.21,0.45],[0.19,0.47],[0.17,0.48],[0.14,0.48],[0.12,0.47],[0.10,0.45],[0.08,0.43],[0.06,0.40],[0.05,0.37],[0.04,0.34],[0.03,0.30],[0.03,0.25],[0.04,0.21]],
  // South America
  [[0.22,0.48],[0.24,0.50],[0.26,0.52],[0.28,0.55],[0.30,0.58],[0.31,0.62],[0.32,0.66],[0.32,0.70],[0.31,0.74],[0.30,0.78],[0.28,0.82],[0.26,0.85],[0.24,0.87],[0.22,0.85],[0.21,0.82],[0.20,0.78],[0.19,0.74],[0.19,0.70],[0.20,0.66],[0.20,0.62],[0.20,0.58],[0.21,0.54],[0.21,0.50]],
  // Europe
  [[0.47,0.14],[0.49,0.16],[0.50,0.18],[0.51,0.21],[0.52,0.24],[0.51,0.27],[0.50,0.30],[0.49,0.32],[0.48,0.34],[0.47,0.32],[0.46,0.30],[0.45,0.28],[0.44,0.26],[0.44,0.23],[0.45,0.20],[0.46,0.17]],
  // Africa
  [[0.47,0.34],[0.49,0.36],[0.51,0.38],[0.53,0.40],[0.54,0.44],[0.55,0.48],[0.55,0.52],[0.55,0.56],[0.54,0.60],[0.53,0.64],[0.52,0.68],[0.50,0.72],[0.48,0.74],[0.46,0.72],[0.44,0.70],[0.43,0.66],[0.42,0.62],[0.42,0.58],[0.42,0.54],[0.43,0.50],[0.43,0.46],[0.44,0.42],[0.45,0.38],[0.46,0.36]],
  // Asia
  [[0.52,0.14],[0.55,0.12],[0.58,0.11],[0.62,0.10],[0.66,0.12],[0.70,0.14],[0.73,0.16],[0.76,0.18],[0.78,0.20],[0.80,0.23],[0.81,0.26],[0.82,0.30],[0.80,0.33],[0.78,0.36],[0.76,0.38],[0.73,0.40],[0.70,0.42],[0.68,0.44],[0.65,0.45],[0.62,0.44],[0.60,0.42],[0.58,0.40],[0.56,0.38],[0.54,0.36],[0.53,0.33],[0.52,0.30],[0.52,0.26],[0.52,0.22],[0.52,0.18]],
  // Australia
  [[0.78,0.58],[0.80,0.56],[0.83,0.55],[0.86,0.56],[0.88,0.58],[0.89,0.61],[0.88,0.64],[0.86,0.67],[0.84,0.69],[0.81,0.70],[0.79,0.68],[0.77,0.66],[0.76,0.63],[0.77,0.60]],
];

let mapLocations = [];

function setupMap() {
  const canvas = document.getElementById('world-map-canvas');
  const enableBtn = document.getElementById('map-enable-location');

  // Resize canvas to container
  function resizeCanvas() {
    const container = document.getElementById('map-container');
    if (container) {
      canvas.width = container.clientWidth;
      canvas.height = Math.max(200, Math.floor(container.clientWidth * 0.53));
    }
  }

  window.addEventListener('resize', () => {
    resizeCanvas();
    drawMap();
  });

  // Enable location button
  if (enableBtn) {
    enableBtn.addEventListener('click', async () => {
      const result = await window.socialAPI.requestLocationPermission();
      if (result.granted) {
        await detectAndSaveLocation();
        loadMapData();
      }
      updateConsentBanner();
    });
  }

  // Tooltip on hover
  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const tooltip = document.getElementById('map-tooltip');
    let found = null;

    for (const loc of mapLocations) {
      const pos = latLngToCanvas(loc.lat, loc.lng, canvas.width, canvas.height);
      const dx = mx - pos.x;
      const dy = my - pos.y;
      if (dx * dx + dy * dy < 64) { // 8px radius
        found = loc;
        break;
      }
    }

    if (found) {
      tooltip.textContent = `${found.display_name || found.username}${found.city ? ' — ' + found.city : ''}${found.country ? ', ' + found.country : ''}`;
      tooltip.style.left = `${e.clientX - rect.left + 10}px`;
      tooltip.style.top = `${e.clientY - rect.top - 24}px`;
      tooltip.classList.remove('hidden');
      canvas.style.cursor = 'pointer';
    } else {
      tooltip.classList.add('hidden');
      canvas.style.cursor = 'default';
    }
  });

  canvas.addEventListener('mouseleave', () => {
    document.getElementById('map-tooltip').classList.add('hidden');
  });

  resizeCanvas();
}

function latLngToCanvas(lat, lng, w, h) {
  // Mercator projection: lng → x linear, lat → y with mercator
  const x = ((lng + 180) / 360) * w;
  // Clamp latitude to avoid infinity
  const latRad = Math.max(-85, Math.min(85, lat)) * Math.PI / 180;
  const mercY = Math.log(Math.tan(Math.PI / 4 + latRad / 2));
  const y = (0.5 - mercY / (2 * Math.PI)) * h;
  return { x, y };
}

function drawMap() {
  const canvas = document.getElementById('world-map-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;

  // Clear
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, w, h);

  // Draw grid lines
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth = 0.5;

  // Longitude lines every 30 degrees
  for (let lng = -180; lng <= 180; lng += 30) {
    const pos = latLngToCanvas(0, lng, w, h);
    ctx.beginPath();
    ctx.moveTo(pos.x, 0);
    ctx.lineTo(pos.x, h);
    ctx.stroke();
  }

  // Latitude lines every 30 degrees
  for (let lat = -60; lat <= 60; lat += 30) {
    const pos = latLngToCanvas(lat, 0, w, h);
    ctx.beginPath();
    ctx.moveTo(0, pos.y);
    ctx.lineTo(w, pos.y);
    ctx.stroke();
  }

  // Draw coastlines
  ctx.strokeStyle = '#2a2a2a';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#151515';

  for (const polygon of WORLD_COASTLINES) {
    ctx.beginPath();
    for (let i = 0; i < polygon.length; i++) {
      const px = polygon[i][0] * w;
      const py = polygon[i][1] * h;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  // Draw user dots
  for (const loc of mapLocations) {
    const pos = latLngToCanvas(loc.lat, loc.lng, w, h);
    const radius = loc.is_self ? 5 : 4;

    // Glow
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, radius + 3, 0, Math.PI * 2);
    if (loc.is_self) {
      ctx.fillStyle = 'rgba(205, 127, 93, 0.2)';
    } else if (loc.is_friend) {
      ctx.fillStyle = 'rgba(57, 255, 20, 0.15)';
    } else {
      ctx.fillStyle = 'rgba(100, 100, 100, 0.1)';
    }
    ctx.fill();

    // Dot
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
    if (loc.is_self) {
      ctx.fillStyle = '#cd7f5d';
    } else if (loc.is_friend) {
      ctx.fillStyle = '#39ff14';
    } else {
      ctx.fillStyle = '#555';
    }
    ctx.fill();

    // Border
    ctx.strokeStyle = loc.is_self ? '#e8a87c' : (loc.is_friend ? '#5aff3e' : '#666');
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

async function updateConsentBanner() {
  const banner = document.getElementById('map-consent-banner');
  if (!banner) return;
  const { consent } = await window.socialAPI.getLocationConsent();
  if (consent === 'granted') {
    banner.classList.add('hidden');
  } else {
    banner.classList.remove('hidden');
  }
}

async function detectAndSaveLocation() {
  const location = await window.socialAPI.getIpLocation();
  if (location && !location.error) {
    await window.socialAPI.updateLocation(location);
  }
}

async function loadMapData() {
  // Check consent and show banner if needed
  await updateConsentBanner();

  // Auto-detect location on first load if permission granted
  const { consent } = await window.socialAPI.getLocationConsent();
  if (consent === 'granted') {
    // Detect and save in background (won't block map render)
    detectAndSaveLocation().catch(() => {});
  }

  try {
    mapLocations = await window.socialAPI.getFriendLocations();
  } catch {
    mapLocations = [];
  }

  drawMap();
}

// ── Auto-refresh every 30 seconds ───────────────────────────────────────────
setInterval(() => { loadData(); }, 30000);
