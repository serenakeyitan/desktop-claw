// Login / Sign-up renderer script

document.addEventListener('DOMContentLoaded', () => {
  const loginForm    = document.getElementById('login-form');
  const signupForm   = document.getElementById('signup-form');
  const forgotForm   = document.getElementById('forgot-form');
  const resetForm    = document.getElementById('reset-form');
  const successPanel = document.getElementById('success-panel');

  // Helper: hide all panels, show one
  function showPanel(panel) {
    [loginForm, signupForm, forgotForm, resetForm, successPanel].forEach(p => p.classList.add('hidden'));
    panel.classList.remove('hidden');
  }

  // ── Toggle between login / signup / forgot ──
  document.getElementById('show-signup').addEventListener('click', (e) => {
    e.preventDefault();
    showPanel(signupForm);
  });

  document.getElementById('show-login').addEventListener('click', (e) => {
    e.preventDefault();
    showPanel(loginForm);
  });

  document.getElementById('show-forgot').addEventListener('click', (e) => {
    e.preventDefault();
    showPanel(forgotForm);
  });

  document.getElementById('forgot-back-login').addEventListener('click', (e) => {
    e.preventDefault();
    showPanel(loginForm);
  });

  document.getElementById('reset-back-login').addEventListener('click', (e) => {
    e.preventDefault();
    showPanel(loginForm);
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

  // ── Forgot Password: send OTP code ──
  let resetEmail = ''; // carry email from forgot → reset form

  document.getElementById('forgot-btn').addEventListener('click', async () => {
    const email = document.getElementById('forgot-email').value.trim();
    const errEl = document.getElementById('forgot-error');
    const sentEl = document.getElementById('forgot-sent');
    errEl.classList.add('hidden');
    sentEl.classList.add('hidden');

    if (!email) {
      errEl.textContent = 'Please enter your email';
      errEl.classList.remove('hidden');
      return;
    }

    const btn = document.getElementById('forgot-btn');
    btn.disabled = true;
    btn.textContent = 'Sending...';

    try {
      const result = await window.socialAPI.sendPasswordReset(email);
      if (result.error) {
        errEl.textContent = result.error;
        errEl.classList.remove('hidden');
      } else {
        resetEmail = email;
        sentEl.classList.remove('hidden');
        btn.textContent = 'Sent!';
        // Auto-navigate to the OTP + new password form after 1.5s
        setTimeout(() => showPanel(resetForm), 1500);
      }
    } catch (err) {
      errEl.textContent = err.message || 'Failed to send reset email';
      errEl.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      if (btn.textContent === 'Sending...') btn.textContent = 'Send Code';
    }
  });

  // ── Reset Password: verify OTP + set new password ──
  document.getElementById('reset-btn').addEventListener('click', async () => {
    const otp = document.getElementById('reset-otp').value.trim();
    const password = document.getElementById('reset-password').value;
    const confirm = document.getElementById('reset-password-confirm').value;
    const errEl = document.getElementById('reset-error');
    const successEl = document.getElementById('reset-success');
    errEl.classList.add('hidden');
    successEl.classList.add('hidden');

    if (!otp || otp.length < 6) {
      errEl.textContent = 'Please enter the code from your email';
      errEl.classList.remove('hidden');
      return;
    }
    if (!password || password.length < 6) {
      errEl.textContent = 'Password must be at least 6 characters';
      errEl.classList.remove('hidden');
      return;
    }
    if (password !== confirm) {
      errEl.textContent = 'Passwords do not match';
      errEl.classList.remove('hidden');
      return;
    }
    if (!resetEmail) {
      errEl.textContent = 'Session expired. Please go back and request a new code.';
      errEl.classList.remove('hidden');
      return;
    }

    const btn = document.getElementById('reset-btn');
    btn.disabled = true;
    btn.textContent = 'Updating...';

    try {
      const result = await window.socialAPI.resetPassword(resetEmail, otp, password);
      if (result.error) {
        errEl.textContent = result.error;
        errEl.classList.remove('hidden');
      } else {
        successEl.classList.remove('hidden');
        btn.textContent = 'Updated!';
        resetEmail = '';
        // Auto-switch to login after 2s
        setTimeout(() => showPanel(loginForm), 2000);
      }
    } catch (err) {
      errEl.textContent = err.message || 'Failed to update password';
      errEl.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      if (btn.textContent === 'Updating...') btn.textContent = 'Update Password';
    }
  });

  // Enter-key support
  document.getElementById('login-password').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') document.getElementById('login-btn').click();
  });
  document.getElementById('signup-password').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') document.getElementById('signup-btn').click();
  });
  document.getElementById('forgot-email').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') document.getElementById('forgot-btn').click();
  });
  document.getElementById('reset-password-confirm').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') document.getElementById('reset-btn').click();
  });
});
