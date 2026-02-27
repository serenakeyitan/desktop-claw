#!/usr/bin/env bash
set -euo pipefail

# ── All Day Poke Installer ───────────────────────────────────────────────────
# Usage: curl -fsSL https://raw.githubusercontent.com/serenakeyitan/desktop-claw/main/install.sh | bash
# ─────────────────────────────────────────────────────────────────────────

GITHUB_REPO="serenakeyitan/desktop-claw"
APP_NAME="All Day Poke.app"
INSTALL_DIR="/Applications"

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

# Check for curl
if ! command -v curl &>/dev/null; then
  fail "curl is required."
fi

ok "macOS detected"

# ── Download latest release ──────────────────────────────────────────────

info "Fetching latest release..."

# Get the latest .dmg URL from GitHub Releases
DMG_URL=$(curl -sSL "https://api.github.com/repos/${GITHUB_REPO}/releases/latest" 2>/dev/null \
  | grep -o '"browser_download_url": *"[^"]*\.dmg"' \
  | head -1 \
  | sed 's/"browser_download_url": *"//' \
  | sed 's/"$//' || true)

if [[ -z "$DMG_URL" ]]; then
  # Fallback: try to find any .dmg in latest release assets
  warn "No .dmg found in latest release. Falling back to source install..."

  # Source install fallback (git clone + npm install)
  REPO="https://github.com/${GITHUB_REPO}.git"
  SOURCE_DIR="$HOME/.alldaypoke"

  if ! command -v git &>/dev/null; then
    fail "git is required for source install. Install Xcode CLT: xcode-select --install"
  fi
  if ! command -v node &>/dev/null; then
    fail "Node.js v18+ is required for source install. Install from https://nodejs.org"
  fi

  if [[ -d "$SOURCE_DIR/.git" ]]; then
    info "Updating existing source installation..."
    git -C "$SOURCE_DIR" pull --ff-only 2>/dev/null || {
      rm -rf "$SOURCE_DIR"
      git clone --depth 1 "$REPO" "$SOURCE_DIR"
    }
  else
    [[ -d "$SOURCE_DIR" ]] && rm -rf "$SOURCE_DIR"
    git clone --depth 1 "$REPO" "$SOURCE_DIR"
  fi

  cd "$SOURCE_DIR"
  npm install --no-fund --no-audit 2>&1 | tail -1
  chmod +x "$SOURCE_DIR/alldaypoke"

  # Symlink CLI
  BIN_LINK="/usr/local/bin/alldaypoke"
  if [[ -w "$(dirname "$BIN_LINK")" ]]; then
    ln -sf "$SOURCE_DIR/alldaypoke" "$BIN_LINK"
  else
    mkdir -p "$HOME/bin"
    ln -sf "$SOURCE_DIR/alldaypoke" "$HOME/bin/alldaypoke"
  fi

  echo ""
  printf "${G}${B}  All Day Poke installed (source mode)!${R}\n"
  echo ""
  printf "  Start: ${C}alldaypoke start${R}\n"
  echo ""
  exit 0
fi

ok "Found release: $(basename "$DMG_URL")"

# Download to temp
TMPDIR_DL=$(mktemp -d)
DMG_FILE="$TMPDIR_DL/AllDayPoke.dmg"

info "Downloading..."
curl -fSL --progress-bar -o "$DMG_FILE" "$DMG_URL"
ok "Downloaded $(du -h "$DMG_FILE" | cut -f1 | xargs)"

# ── Mount and install ────────────────────────────────────────────────────

info "Installing to /Applications..."

# Mount the DMG
MOUNT_POINT=$(hdiutil attach "$DMG_FILE" -nobrowse -mountpoint "$TMPDIR_DL/mnt" 2>/dev/null | grep -o '/Volumes/.*' | head -1)

if [[ -z "$MOUNT_POINT" ]]; then
  MOUNT_POINT="$TMPDIR_DL/mnt"
fi

# Find the .app inside
APP_SRC=$(find "$MOUNT_POINT" -maxdepth 1 -name "*.app" -print -quit 2>/dev/null)

if [[ -z "$APP_SRC" ]]; then
  hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null || true
  rm -rf "$TMPDIR_DL"
  fail "Could not find .app in DMG"
fi

# Remove old version if exists
if [[ -d "$INSTALL_DIR/$APP_NAME" ]]; then
  warn "Removing previous installation..."
  rm -rf "$INSTALL_DIR/$APP_NAME"
fi

# Copy to Applications
cp -R "$APP_SRC" "$INSTALL_DIR/"
ok "Installed to $INSTALL_DIR/$APP_NAME"

# Cleanup
hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null || true
rm -rf "$TMPDIR_DL"

# Remove quarantine attribute (since app is unsigned)
xattr -rd com.apple.quarantine "$INSTALL_DIR/$APP_NAME" 2>/dev/null || true

# ── Done ─────────────────────────────────────────────────────────────────

echo ""
printf "${G}${B}  All Day Poke installed successfully!${R}\n"
echo ""
echo "  Launch the app:"
printf "    ${C}open '/Applications/${APP_NAME}'${R}\n"
echo ""
echo "  Or find it in Launchpad / Applications folder."
echo ""
