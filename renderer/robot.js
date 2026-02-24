// Pixel-art robot SVG generator with animations - Exact match to claude-code.png
class PixelRobot {
  constructor(container) {
    this.container = container;
    this.state = 'idle';
    this.pixelSize = 8; // Size of each "pixel" in the art
    this.gridWidth = 12;
    this.gridHeight = 8;

    // Colors matching the PNG exactly
    this.colors = {
      body: '#cd7f5d',        // Terracotta/orange body (exact match)
      eyes: '#1a1a1a',        // Black eyes
      eyesActive: '#ffffff',  // White eyes when active
      feet: '#cd7f5d',        // Same color feet
      background: '#2d2d30'   // Dark background (optional)
    };

    this.createRobot();
    this.setState('idle');
  }

  createRobot() {
    // Create main SVG
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', this.gridWidth * this.pixelSize);
    svg.setAttribute('height', this.gridHeight * this.pixelSize);
    svg.setAttribute('viewBox', `0 0 ${this.gridWidth * this.pixelSize} ${this.gridHeight * this.pixelSize}`);
    svg.classList.add('pixel-robot');

    // Exact robot design from claude-code.png (12x8 grid)
    const design = [
      //012345678901
      ' ########## ', // 0 - Top of body
      ' ########## ', // 1 - Body
      ' # ##  ## # ', // 2 - Eyes row
      ' ########## ', // 3 - Body
      ' ########## ', // 4 - Body bottom
      '            ', // 5 - Space
      '  ##    ##  ', // 6 - Feet
      '            '  // 7 - Bottom space
    ];

    // Create pixel groups for animation
    this.pixelGroups = {
      body: [],
      eyes: [],
      feet: []
    };

    // Parse design and create pixels
    design.forEach((row, y) => {
      row.split('').forEach((char, x) => {
        if (char !== ' ') {
          const rect = this.createPixel(x, y, char);
          if (rect) {
            svg.appendChild(rect);
          }
        }
      });
    });

    // Add CRT scanline effect overlay
    const scanlines = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    scanlines.classList.add('scanlines');

    for (let i = 0; i < this.gridHeight; i += 2) {
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      line.setAttribute('x', '0');
      line.setAttribute('y', i * this.pixelSize);
      line.setAttribute('width', this.gridWidth * this.pixelSize);
      line.setAttribute('height', this.pixelSize);
      line.setAttribute('fill', 'rgba(0,0,0,0.05)');
      line.setAttribute('pointer-events', 'none');
      scanlines.appendChild(line);
    }

    svg.appendChild(scanlines);
    this.container.appendChild(svg);
    this.svg = svg;
  }

  createPixel(x, y, char) {
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', x * this.pixelSize);
    rect.setAttribute('y', y * this.pixelSize);
    rect.setAttribute('width', this.pixelSize);
    rect.setAttribute('height', this.pixelSize);

    // Simple design - only body (#) and spaces
    let color = this.colors.body;
    let group = 'body';

    if (char === '#') {
      // Check if this is an eye or feet pixel
      if (y === 2 && (x === 3 || x === 4 || x === 7 || x === 8)) {
        // Eyes (the spaces in the eyes row are the actual eyes)
        // Skip these positions as they'll be spaces
        color = this.colors.body;
        group = 'body';
      } else if (y === 6) {
        // Feet
        color = this.colors.feet;
        group = 'feet';
      } else {
        // Regular body
        color = this.colors.body;
        group = 'body';
      }
    } else if (char === ' ') {
      // Check if this is an eye position
      if (y === 2 && ((x >= 3 && x <= 4) || (x >= 7 && x <= 8))) {
        // This is an eye!
        color = this.colors.eyes;
        group = 'eyes';
        rect.classList.add('eye-pixel');

        rect.setAttribute('fill', color);
        rect.classList.add(`robot-${group}`);

        if (this.pixelGroups[group]) {
          this.pixelGroups[group].push(rect);
        }

        return rect;
      }
      // Otherwise it's empty space, don't create a pixel
      return null;
    }

    rect.setAttribute('fill', color);
    rect.classList.add(`robot-${group}`);

    // Store in group for animations
    if (this.pixelGroups[group]) {
      this.pixelGroups[group].push(rect);
    }

    return rect;
  }

  setState(newState) {
    if (this.state === newState) return;

    this.state = newState;

    // Remove all state classes
    this.svg.classList.remove('state-idle', 'state-active');

    // Add new state class
    this.svg.classList.add(`state-${newState}`);

    // Update specific elements based on state
    if (newState === 'active') {
      // Bright white eyes when active
      this.pixelGroups.eyes.forEach(pixel => {
        pixel.setAttribute('fill', this.colors.eyesActive);
      });

      // Add vibration class
      this.svg.classList.add('vibrating');

    } else if (newState === 'idle') {
      // Normal black eyes when idle
      this.pixelGroups.eyes.forEach(pixel => {
        pixel.setAttribute('fill', this.colors.eyes);
      });

      // Remove vibration
      this.svg.classList.remove('vibrating');
    }
  }

  // Trigger a pat-head (拍拍头) animation — robot squishes and bounces for 3 seconds
  patHead() {
    if (this._patting) return; // don't stack
    this._patting = true;

    // Show a hand emoji above the robot
    const hand = document.createElement('div');
    hand.className = 'poke-hand';
    hand.textContent = '✋';
    this.container.appendChild(hand);

    // Add pat-head class to SVG for squish animation
    this.svg.classList.add('pat-head');

    // Make eyes happy (become little crescents via color change)
    this.pixelGroups.eyes.forEach(pixel => {
      pixel.setAttribute('fill', '#ffcc00');
    });

    // Remove after 3 seconds
    setTimeout(() => {
      this.svg.classList.remove('pat-head');
      hand.remove();
      // Restore eyes to current state
      const eyeColor = this.state === 'active'
        ? this.colors.eyesActive
        : this.colors.eyes;
      this.pixelGroups.eyes.forEach(pixel => {
        pixel.setAttribute('fill', eyeColor);
      });
      this._patting = false;
    }, 3000);
  }

  // Trigger a blink animation
  blink() {
    this.pixelGroups.eyes.forEach(pixel => {
      pixel.style.animation = 'blink 0.2s ease-in-out';
    });

    setTimeout(() => {
      this.pixelGroups.eyes.forEach(pixel => {
        pixel.style.animation = '';
      });
    }, 200);
  }
}

// Export for use in main renderer
if (typeof module !== 'undefined' && module.exports) {
  module.exports = PixelRobot;
}