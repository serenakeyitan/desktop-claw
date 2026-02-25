/**
 * Supabase Client — initialization and auth helpers
 *
 * Reads SUPABASE_URL and SUPABASE_ANON_KEY from the app config file
 * (~/.alldaypoke/config.json).  Provides sign-up, sign-in, sign-out,
 * session restore, and profile management (username + invite code).
 */

const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const log = require('./logger');

const CONFIG_DIR = path.join(os.homedir(), '.alldaypoke');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const SESSION_FILE = path.join(CONFIG_DIR, 'supabase-session.json');

// Bundled Supabase credentials (anon key is public-safe; RLS protects data)
const BUNDLED_SUPABASE_URL = 'https://eukdqgkfqiwqfrnjvfdg.supabase.co';
const BUNDLED_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV1a2RxZ2tmcWl3cWZybmp2ZmRnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE4Mjc1MjAsImV4cCI6MjA4NzQwMzUyMH0.693TeAuKRYPW4NMIY5Bk-XJXtJofQgO3k_ikmPJVFOU';

let supabase = null;

// ── helpers ────────────────────────────────────────────────────────────────

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch { /* ignore */ }
  return {};
}

function saveConfig(config) {
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (err) {
    log.error('supabase-client: failed to save config', err.message);
  }
}

function saveSession(session) {
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
  } catch (err) {
    log.error('supabase-client: failed to save session', err.message);
  }
}

function loadSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    }
  } catch { /* ignore */ }
  return null;
}

function clearSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
  } catch { /* ignore */ }
}

// ── init ───────────────────────────────────────────────────────────────────

/**
 * Initialise (or return existing) Supabase client.
 * Call this once at app start; subsequent calls return the cached instance.
 */
function getSupabase() {
  if (supabase) return supabase;

  const config = loadConfig();
  const url = config.supabaseUrl || process.env.SUPABASE_URL || BUNDLED_SUPABASE_URL;
  const key = config.supabaseAnonKey || process.env.SUPABASE_ANON_KEY || BUNDLED_SUPABASE_ANON_KEY;

  if (!url || !key) {
    log.warn('supabase-client: missing Supabase credentials');
    return null;
  }

  supabase = createClient(url, key, {
    auth: {
      autoRefreshToken: true,
      persistSession: false, // we persist manually to a file
    },
  });

  return supabase;
}

// ── auth ───────────────────────────────────────────────────────────────────

/**
 * Try to restore a previous session from disk.
 * Returns the user object or null.
 */
async function restoreSession() {
  const sb = getSupabase();
  if (!sb) return null;

  const saved = loadSession();
  if (!saved?.access_token || !saved?.refresh_token) return null;

  const { data, error } = await sb.auth.setSession({
    access_token: saved.access_token,
    refresh_token: saved.refresh_token,
  });

  if (error || !data.session) {
    log.warn('supabase-client: session restore failed', error?.message);
    clearSession();
    return null;
  }

  // Persist the (possibly refreshed) tokens
  saveSession({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
  });

  return data.session.user;
}

/**
 * Sign up with email + password.  Creates a profile row automatically.
 */
async function signUp(email, password, username, twitterUsername, githubUsername) {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase not configured');

  const { data, error } = await sb.auth.signUp({ email, password });
  if (error) throw error;

  const user = data.user;
  if (!user) throw new Error('Sign-up succeeded but no user returned');

  // Persist session
  if (data.session) {
    saveSession({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
    });
  }

  // Create profile row (invite code generated server-side via default/trigger,
  // but we can also generate one client-side as a fallback)
  const inviteCode = generateInviteCode();
  const profileRow = {
    id: user.id,
    username,
    display_name: username,
    invite_code: inviteCode,
  };
  if (twitterUsername) profileRow.twitter_username = twitterUsername;
  if (githubUsername) profileRow.github_username = githubUsername;

  const { error: profileErr } = await sb.from('profiles').insert(profileRow);

  if (profileErr) {
    log.error('supabase-client: profile insert failed', profileErr.message);
    // Not fatal — the user can update their profile later
  }

  // Initialise an empty user_status row
  await sb.from('user_status').insert({
    user_id: user.id,
    is_vibing: false,
    current_project: null,
  });

  return { user, inviteCode };
}

/**
 * Sign in with email + password.
 */
async function signIn(email, password) {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase not configured');

  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;

  if (data.session) {
    saveSession({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
    });
  }

  return data.user;
}

/**
 * Sign out and clear persisted session.
 */
async function signOut() {
  const sb = getSupabase();
  if (sb) {
    await sb.auth.signOut().catch(() => {});
  }
  clearSession();
}

/**
 * Get the currently logged-in user (from the in-memory session).
 */
async function getCurrentUser() {
  const sb = getSupabase();
  if (!sb) return null;
  const { data } = await sb.auth.getUser();
  return data?.user ?? null;
}

/**
 * Fetch the logged-in user's profile row.
 */
async function getMyProfile() {
  const sb = getSupabase();
  if (!sb) return null;
  const user = await getCurrentUser();
  if (!user) return null;

  const { data, error } = await sb
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single();

  if (error) {
    log.error('supabase-client: getMyProfile failed', error.message);
    return null;
  }
  return data;
}

/**
 * Update the logged-in user's profile fields (display_name, twitter, github, etc.)
 */
async function updateProfile(updates) {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase not configured');
  const user = await getCurrentUser();
  if (!user) throw new Error('Not logged in');

  // Only allow known fields
  const allowed = ['display_name', 'twitter_username', 'github_username'];
  const safe = {};
  for (const key of allowed) {
    if (key in updates) safe[key] = updates[key] || null;
  }

  const { data, error } = await sb
    .from('profiles')
    .update(safe)
    .eq('id', user.id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

// ── password reset (OTP-based, no link clicking needed) ───────────────────

/**
 * Send a password-reset email containing a 6-digit OTP code.
 */
async function sendPasswordReset(email) {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase not configured');

  const { error } = await sb.auth.resetPasswordForEmail(email);
  if (error) throw error;
}

/**
 * Verify the 6-digit OTP code from the reset email, then set a new password.
 * Step 1: verifyOtp with type 'recovery' → creates a session
 * Step 2: updateUser with new password
 */
async function resetPassword(email, otpCode, newPassword) {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase not configured');

  // Verify the OTP code — this logs the user in with a recovery session
  const { data, error: otpErr } = await sb.auth.verifyOtp({
    email,
    token: otpCode,
    type: 'recovery',
  });
  if (otpErr) throw otpErr;

  // Update password using the recovery session
  const { error: updateErr } = await sb.auth.updateUser({
    password: newPassword,
  });
  if (updateErr) throw updateErr;

  // Clear session — user should log in again with new password
  await sb.auth.signOut().catch(() => {});
  clearSession();
}

// ── invite code helper (client-side fallback) ──────────────────────────────

function generateInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// ── exports ────────────────────────────────────────────────────────────────

module.exports = {
  getSupabase,
  restoreSession,
  signUp,
  signIn,
  signOut,
  getCurrentUser,
  getMyProfile,
  updateProfile,
  sendPasswordReset,
  resetPassword,
  saveConfig,
  loadConfig,
  generateInviteCode,
};
