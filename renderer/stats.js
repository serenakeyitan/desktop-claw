// Stats display module for token usage and countdown
class StatsDisplay {
  constructor() {
    this.tokenFill = document.getElementById('token-fill');
    this.tokenPercentage = document.getElementById('token-percentage');
    this.countdownText = document.getElementById('countdown-text');

    this.resetTime = null;
    this.countdownInterval = null;

    this.startCountdown();
  }

  updateTokenUsage(data) {
    const { used, limit, pct, reset_at, error, demo, cached, type, subscription } = data;

    if (error) {
      this.handleError(error);
      return;
    }

    // Update percentage display
    if (pct !== undefined) {
      // Show subscription type if available
      let displayText = `${pct}%`;
      if (subscription) {
        displayText = `${pct}% (${subscription})`;
      } else if (type === 'messages') {
        // For Claude subscriptions, show as messages
        displayText = `${used}/${limit} msgs`;
      }
      this.tokenPercentage.textContent = displayText;

      // Update bar fill
      this.tokenFill.style.width = `${pct}%`;

      // Update bar color based on usage percentage
      // pct = % used (0 = fresh, 100 = exhausted)
      this.tokenFill.classList.remove('high', 'medium', 'low');
      if (pct < 40) {
        this.tokenFill.classList.add('high');   // green — plenty remaining
      } else if (pct < 70) {
        this.tokenFill.classList.add('medium'); // yellow — moderate usage
      } else {
        this.tokenFill.classList.add('low');    // red — running low
      }

      // Handle near-exhaustion state
      if (pct >= 90) {
        this.tokenPercentage.classList.add('urgent');
      } else {
        this.tokenPercentage.classList.remove('urgent');
      }
    } else {
      this.tokenPercentage.textContent = '-- %';
      this.tokenFill.style.width = '0%';
    }

    // Update reset time
    if (reset_at) {
      this.resetTime = new Date(reset_at);
    }

    // Add indicators for special states
    if (demo) {
      this.countdownText.classList.add('demo');
      if (!this.countdownText.textContent.includes('(demo)')) {
        this.countdownText.textContent += ' (demo)';
      }
    } else {
      this.countdownText.classList.remove('demo');
    }

    if (cached) {
      if (!this.countdownText.textContent.includes('(cached)')) {
        this.countdownText.textContent += ' (cached)';
      }
    }
  }

  handleError(errorMessage) {
    this.tokenPercentage.textContent = '-- %';
    this.tokenFill.style.width = '0%';

    if (errorMessage.toLowerCase().includes('no api key')) {
      this.countdownText.textContent = 'no api key';
      this.countdownText.classList.add('error');
    } else if (errorMessage.toLowerCase().includes('auth')) {
      this.countdownText.textContent = 'auth error';
      this.countdownText.classList.add('error');
    } else if (errorMessage.toLowerCase().includes('rate limit')) {
      this.countdownText.textContent = 'rate limited';
      this.countdownText.classList.add('error');
    } else if (errorMessage.toLowerCase().includes('offline')) {
      this.countdownText.textContent = '(offline)';
      this.countdownText.classList.add('error');
    } else {
      this.countdownText.textContent = 'error';
      this.countdownText.classList.add('error');
    }
  }

  startCountdown() {
    // Update countdown every second
    this.countdownInterval = setInterval(() => {
      this.updateCountdown();
    }, 1000);
  }

  updateCountdown(timeLeftString = null) {
    // If provided with a pre-formatted string, use it
    if (timeLeftString) {
      this.countdownText.textContent = timeLeftString;
      return;
    }

    // Calculate countdown from reset time
    if (!this.resetTime) {
      return;
    }

    const now = new Date();
    const diffMs = this.resetTime - now;

    if (diffMs <= 0) {
      this.countdownText.textContent = 'resetting...';
      this.countdownText.classList.add('urgent');
      return;
    }

    const hours = Math.floor(diffMs / (1000 * 60 * 60));
    const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

    let timeString;
    if (hours > 0) {
      timeString = `resets in ${hours}h ${minutes}m`;
    } else if (minutes > 0) {
      timeString = `resets in ${minutes}m`;
    } else {
      const seconds = Math.floor(diffMs / 1000);
      timeString = `resets in ${seconds}s`;
    }

    this.countdownText.textContent = timeString;

    // Add urgency for low time remaining
    if (diffMs < 5 * 60 * 1000) { // Less than 5 minutes
      this.countdownText.classList.add('urgent');
    } else {
      this.countdownText.classList.remove('urgent');
      this.countdownText.classList.remove('error');
    }
  }

  destroy() {
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }
  }
}

// Export for use in main renderer
if (typeof module !== 'undefined' && module.exports) {
  module.exports = StatsDisplay;
}