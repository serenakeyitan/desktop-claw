/**
 * Social Sync — pushes local usage to Supabase, maintains online status,
 * and fetches friend / global rankings.
 *
 * Usage:
 *   const sync = new SocialSync(usageDB);
 *   await sync.start();          // begins periodic sync + heartbeat
 *   sync.stop();                 // teardown
 *
 *   const friends = await sync.getFriendRanking('today');
 *   const global  = await sync.getGlobalRanking('7d');
 *   const result  = await sync.addFriend('ABCD1234');
 */

const { getSupabase, getCurrentUser } = require('./supabase-client');
const EventEmitter = require('events');

const SYNC_INTERVAL_MS = 2 * 60 * 1000;      // push usage every 2 min
const HEARTBEAT_INTERVAL_MS = 60 * 1000;      // status heartbeat every 1 min

class SocialSync extends EventEmitter {
  constructor(usageDB) {
    super();
    this.usageDB = usageDB;
    this.syncTimer = null;
    this.heartbeatTimer = null;
    this.lastSyncTimestamp = null; // ISO string of the last synced entry
    this.subscriptionTier = null;  // 'pro', 'max_100', 'max_200'
  }

  // ── lifecycle ──────────────────────────────────────────────────────────

  async start() {
    // Initial sync
    await this.syncUsage().catch(err =>
      console.error('SocialSync: initial sync failed', err.message));

    // Periodic sync
    this.syncTimer = setInterval(() => {
      this.syncUsage().catch(err =>
        console.error('SocialSync: sync failed', err.message));
    }, SYNC_INTERVAL_MS);

    // Status heartbeat
    this.heartbeatTimer = setInterval(() => {
      this.pushHeartbeat().catch(err =>
        console.error('SocialSync: heartbeat failed', err.message));
    }, HEARTBEAT_INTERVAL_MS);

    // Send an initial heartbeat
    await this.pushHeartbeat().catch(() => {});
  }

  stop() {
    if (this.syncTimer) { clearInterval(this.syncTimer); this.syncTimer = null; }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }

    // Mark offline
    this.setVibing(false, null).catch(() => {});
  }

  // ── usage sync ─────────────────────────────────────────────────────────

  /**
   * Push un-synced local usage entries to Supabase `usage_logs`.
   */
  async syncUsage() {
    const sb = getSupabase();
    if (!sb) return;
    const user = await getCurrentUser();
    if (!user) return;

    const entries = this.usageDB.getUnsyncedEntries
      ? this.usageDB.getUnsyncedEntries()
      : this._getEntriesSince(this.lastSyncTimestamp);

    if (!entries || entries.length === 0) return;

    // Map local entries to the server schema
    const rows = entries.map(e => ({
      user_id: user.id,
      project: e.project,
      delta_percent: e.deltaPercent,
      active_time_ms: e.activeTimeMs || 0,
      logged_at: e.timestamp,
      date: e.date,
    }));

    const { error } = await sb.from('usage_logs').insert(rows);
    if (error) {
      console.error('SocialSync: insert usage_logs failed', error.message);
      return;
    }

    // Track the latest timestamp we synced so we don't re-send
    const latest = entries[entries.length - 1];
    this.lastSyncTimestamp = latest.timestamp;
    if (this.usageDB.markSynced) {
      this.usageDB.markSynced(latest.timestamp);
    }
    console.log(`SocialSync: pushed ${rows.length} usage entries`);

    this.emit('synced', { count: rows.length });
  }

  /**
   * Fallback: scan usageDB entries newer than a given timestamp.
   */
  _getEntriesSince(since) {
    if (!this.usageDB?.data?.entries) return [];
    if (!since) return [...this.usageDB.data.entries]; // first sync — push everything
    return this.usageDB.data.entries.filter(e => e.timestamp > since);
  }

  /**
   * Return the user's local date as YYYY-MM-DD string.
   * Sent to Supabase RPCs so "today" filtering uses the client's timezone.
   */
  _localDateStr() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  // ── heartbeat / status ─────────────────────────────────────────────────

  /**
   * Set the user's subscription tier (called from main.js when usage data arrives).
   * @param {'pro'|'max_100'|'max_200'} tier
   */
  setSubscriptionTier(tier) {
    if (tier && tier !== this.subscriptionTier) {
      this.subscriptionTier = tier;
      // Sync tier to profile
      this._syncTierToProfile(tier).catch(err =>
        console.error('SocialSync: failed to sync tier', err.message));
    }
  }

  /**
   * Update the user's subscription_tier in their profile row.
   */
  async _syncTierToProfile(tier) {
    const sb = getSupabase();
    if (!sb) return;
    const user = await getCurrentUser();
    if (!user) return;

    const { error } = await sb
      .from('profiles')
      .update({ subscription_tier: tier })
      .eq('id', user.id);

    if (error) {
      console.error('SocialSync: profile tier update failed', error.message);
    } else {
      console.log(`SocialSync: subscription tier synced → ${tier}`);
    }
  }

  /**
   * Push an online heartbeat to `user_status`.
   */
  async pushHeartbeat(isVibing, currentProject) {
    const sb = getSupabase();
    if (!sb) return;
    const user = await getCurrentUser();
    if (!user) return;

    const update = {
      last_active_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    if (isVibing !== undefined) update.is_vibing = isVibing;
    if (currentProject !== undefined) update.current_project = currentProject;

    const { error } = await sb
      .from('user_status')
      .upsert({ user_id: user.id, ...update }, { onConflict: 'user_id' });

    if (error) {
      console.error('SocialSync: heartbeat upsert failed', error.message);
    }
  }

  /**
   * Convenience: set vibing status + optional project name.
   */
  async setVibing(isVibing, currentProject) {
    return this.pushHeartbeat(isVibing, currentProject);
  }

  // ── rankings ───────────────────────────────────────────────────────────

  /**
   * Fetch friend ranking from the server RPC function.
   * @param {'today'|'7d'|'30d'|'all'} period
   */
  async getFriendRanking(period = 'all') {
    const sb = getSupabase();
    if (!sb) return [];
    const { data, error } = await sb.rpc('get_friend_ranking', {
      period,
      client_today: this._localDateStr(),
    });
    if (error) {
      console.error('SocialSync: get_friend_ranking failed', error.message);
      return [];
    }
    return data || [];
  }

  /**
   * Fetch global ranking from the server RPC function.
   * @param {'today'|'7d'|'30d'|'all'} period
   * @param {number} limit
   */
  async getGlobalRanking(period = 'all', limit = 50) {
    const sb = getSupabase();
    if (!sb) return [];
    const { data, error } = await sb.rpc('get_global_ranking', {
      period,
      lim: limit,
      client_today: this._localDateStr(),
    });
    if (error) {
      console.error('SocialSync: get_global_ranking failed', error.message);
      return [];
    }
    return data || [];
  }

  // ── friends ────────────────────────────────────────────────────────────

  /**
   * Add a friend by their invite code.
   */
  async addFriend(code) {
    const sb = getSupabase();
    if (!sb) throw new Error('Not connected');
    const { data, error } = await sb.rpc('add_friend_by_code', { code });
    if (error) throw error;
    return data; // { success, friend?, error? }
  }

  /**
   * Get list of friends (profiles).
   */
  async getFriends() {
    const sb = getSupabase();
    if (!sb) return [];
    const user = await getCurrentUser();
    if (!user) return [];

    const { data, error } = await sb
      .from('friendships')
      .select('friend_id, profiles!friendships_friend_id_fkey(username, display_name, avatar_url)')
      .eq('user_id', user.id);

    if (error) {
      console.error('SocialSync: getFriends failed', error.message);
      return [];
    }

    return (data || []).map(row => ({
      id: row.friend_id,
      username: row.profiles?.username,
      displayName: row.profiles?.display_name,
      avatarUrl: row.profiles?.avatar_url,
    }));
  }

  /**
   * Remove a friend (bidirectional).
   */
  async removeFriend(friendId) {
    const sb = getSupabase();
    if (!sb) return;
    const user = await getCurrentUser();
    if (!user) return;

    // Remove both directions
    await sb.from('friendships').delete()
      .eq('user_id', user.id).eq('friend_id', friendId);
    await sb.from('friendships').delete()
      .eq('user_id', friendId).eq('friend_id', user.id);
  }
}

module.exports = SocialSync;
