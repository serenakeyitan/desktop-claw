#!/usr/bin/env bash
set -euo pipefail

# ── All Day Poke Installer ───────────────────────────────────────────────────
# Usage: curl -fsSL https://raw.githubusercontent.com/serenakeyitan/desktop-claw/main/install.sh | bash
# ─────────────────────────────────────────────────────────────────────────

REPO="https://github.com/serenakeyitan/desktop-claw.git"
INSTALL_DIR="$HOME/.alldaypoke"
BIN_LINK="/usr/local/bin/alldaypoke"

# Colors
R='\033[0m' B='\033[1m' G='\033[32m' Y='\033[33m' C='\033[36m' RED='\033[31m'

info()  { printf "${C}${B}>>>${R} %s\n" "$*"; }
ok()    { printf "${G}${B} ✓${R} %s\n" "$*"; }
warn()  { printf "${Y}${B} !${R} %s\n" "$*"; }
fail()  { printf "${RED}${B} ✗${R} %s\n" "$*"; exit 1; }

# ── Pre-flight checks ────────────────────────────────────────────────────

info "All Day Poke installer"
echo ""

# Check OS (macOS only for now)
if [[ "$(uname)" != "Darwin" ]]; then
  fail "All Day Poke currently supports macOS only."
fi

# Check for git
if ! command -v git &>/dev/null; then
  fail "git is required. Install Xcode CLT:  xcode-select --install"
fi

# Check for Node.js
if ! command -v node &>/dev/null; then
  fail "Node.js is required (v18+). Install from https://nodejs.org or:  brew install node"
fi

NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if (( NODE_MAJOR < 18 )); then
  fail "Node.js v18+ required (found v$(node -v | tr -d v)). Please upgrade."
fi

# Check for npm
if ! command -v npm &>/dev/null; then
  fail "npm is required and should come with Node.js."
fi

ok "Prerequisites satisfied (Node $(node -v), npm $(npm -v))"

# ── Clone or update ──────────────────────────────────────────────────────

if [[ -d "$INSTALL_DIR/.git" ]]; then
  info "Updating existing installation..."
  git -C "$INSTALL_DIR" pull --ff-only || {
    warn "Pull failed — re-cloning..."
    rm -rf "$INSTALL_DIR"
    git clone --depth 1 "$REPO" "$INSTALL_DIR"
  }
  ok "Updated to latest version"
else
  if [[ -d "$INSTALL_DIR" ]]; then
    warn "Removing stale $INSTALL_DIR"
    rm -rf "$INSTALL_DIR"
  fi
  info "Cloning All Day Poke..."
  git clone --depth 1 "$REPO" "$INSTALL_DIR"
  ok "Cloned to $INSTALL_DIR"
fi

# ── Install dependencies ─────────────────────────────────────────────────

info "Installing dependencies..."
cd "$INSTALL_DIR"
npm install --no-fund --no-audit 2>&1 | tail -1
ok "Dependencies installed"

# ── Create config directory ──────────────────────────────────────────────

mkdir -p "$HOME/.alldaypoke"

# ── Symlink CLI ──────────────────────────────────────────────────────────

info "Setting up 'alldaypoke' command..."

# Make the launcher executable
chmod +x "$INSTALL_DIR/alldaypoke"

# Try /usr/local/bin first, fall back to ~/bin
if [[ -w "$(dirname "$BIN_LINK")" ]] || sudo -n true 2>/dev/null; then
  # Can write to /usr/local/bin (or have passwordless sudo)
  if [[ -w "$(dirname "$BIN_LINK")" ]]; then
    ln -sf "$INSTALL_DIR/alldaypoke" "$BIN_LINK"
  else
    sudo ln -sf "$INSTALL_DIR/alldaypoke" "$BIN_LINK"
  fi
  ok "Linked: alldaypoke -> $BIN_LINK"
else
  # Fallback: ~/bin
  mkdir -p "$HOME/bin"
  ln -sf "$INSTALL_DIR/alldaypoke" "$HOME/bin/alldaypoke"
  ok "Linked: alldaypoke -> ~/bin/alldaypoke"
  if [[ ":$PATH:" != *":$HOME/bin:"* ]]; then
    warn "Add ~/bin to your PATH:  export PATH=\"\$HOME/bin:\$PATH\""
  fi
fi

# ── Done ─────────────────────────────────────────────────────────────────

echo ""
printf "${G}${B}  All Day Poke installed successfully!${R}\n"
echo ""
echo "  Start the app:"
printf "    ${C}alldaypoke start${R}\n"
echo ""
echo "  Or launch directly:"
printf "    ${C}cd $INSTALL_DIR && npm start${R}\n"
echo ""
echo "  Other commands:"
printf "    ${C}alldaypoke help${R}          Show all commands\n"
printf "    ${C}alldaypoke setup${R}         Configure authentication\n"
echo ""
