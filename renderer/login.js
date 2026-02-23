// Login / Sign-up renderer script

document.addEventListener('DOMContentLoaded', () => {
  const loginForm   = document.getElementById('login-form');
  const signupForm  = document.getElementById('signup-form');
  const successPanel = document.getElementById('success-panel');

  // ── Toggle between login / signup ──
  document.getElementById('show-signup').addEventListener('click', (e) => {
    e.preventDefault();
    loginForm.classList.add('hidden');
    signupForm.classList.remove('hidden');
  });

  document.getElementById('show-login').addEventListener('click', (e) => {
    e.preventDefault();
    signupForm.classList.add('hidden');
    loginForm.classList.remove('hidden');
  });

  // ── Sign In ──
  document.getElementById('login-btn').addEventListener('click', async () => {
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    const errEl = document.getElementById('login-error');
    errEl.classList.add('hidden');

    if (!email || !password) {
      errEl.textContent = 'Please enter email and password';
      errEl.classList.remove('hidden');
      return;
    }

    const btn = document.getElementById('login-btn');
    btn.disabled = true;
    btn.textContent = 'Signing in...';

    try {
      const result = await window.socialAPI.signIn(email, password);
      if (result.error) {
        errEl.textContent = result.error;
        errEl.classList.remove('hidden');
      } else {
        // Login succeeded — main process will close this window
        btn.textContent = 'Success!';
      }
    } catch (err) {
      errEl.textContent = err.message || 'Sign-in failed';
      errEl.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      if (btn.textContent === 'Signing in...') btn.textContent = 'Sign In';
    }
  });

  // ── Sign Up ──
  document.getElementById('signup-btn').addEventListener('click', async () => {
    const username = document.getElementById('signup-username').value.trim();
    const email = document.getElementById('signup-email').value.trim();
    const password = document.getElementById('signup-password').value;
    const errEl = document.getElementById('signup-error');
    errEl.classList.add('hidden');

    if (!username || !email || !password) {
      errEl.textContent = 'All fields are required';
      errEl.classList.remove('hidden');
      return;
    }
    if (password.length < 6) {
      errEl.textContent = 'Password must be at least 6 characters';
      errEl.classList.remove('hidden');
      return;
    }

    const btn = document.getElementById('signup-btn');
    btn.disabled = true;
    btn.textContent = 'Creating account...';

    try {
      const result = await window.socialAPI.signUp(email, password, username);
      if (result.error) {
        errEl.textContent = result.error;
        errEl.classList.remove('hidden');
      } else {
        // Show success panel with invite link
        signupForm.classList.add('hidden');
        successPanel.classList.remove('hidden');

        document.getElementById('welcome-msg').textContent =
          `Welcome, ${username}! Your account has been created.`;

        const code = result.inviteCode || '--------';
        const link = `https://serenakeyitan.github.io/desktop-claw/invite/?code=${code}`;
        document.getElementById('invite-link').textContent = link;

        // Show friend-added message if came via invite link
        if (result.friendAdded) {
          const msg = document.getElementById('friend-added-msg');
          msg.textContent = `You and ${result.friendAdded} are now friends!`;
          msg.classList.remove('hidden');
        }
      }
    } catch (err) {
      errEl.textContent = err.message || 'Sign-up failed';
      errEl.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      if (btn.textContent === 'Creating account...') btn.textContent = 'Create Account';
    }
  });

  // ── Copy invite link ──
  document.getElementById('copy-invite').addEventListener('click', () => {
    const link = document.getElementById('invite-link').textContent;
    navigator.clipboard.writeText(link).then(() => {
      document.getElementById('copy-invite').textContent = 'Copied!';
      setTimeout(() => {
        document.getElementById('copy-invite').textContent = 'Copy Link';
      }, 2000);
    });
  });

  // ── Continue (close login window) ──
  document.getElementById('continue-btn').addEventListener('click', () => {
    // Signal main process that login is done
    window.socialAPI.signIn('__continue__', '').catch(() => {});
    // Window will be closed by main process
  });

  // Enter-key support
  document.getElementById('login-password').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') document.getElementById('login-btn').click();
  });
  document.getElementById('signup-password').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') document.getElementById('signup-btn').click();
  });
});
