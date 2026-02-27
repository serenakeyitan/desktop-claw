#!/usr/bin/env bash
set -euo pipefail

# ── All Day Poke Installer ───────────────────────────────────────────────────
# Usage: curl -fsSL https://raw.githubusercontent.com/serenakeyitan/desktop-claw/main/install.sh | bash
# ─────────────────────────────────────────────────────────────────────────

GITHUB_REPO="serenakeyitan/desktop-claw"
APP_NAME="All Day Poke.app"
INSTALL_DIR="/Applications"

# ── Colors ──────────────────────────────────────────────────────────────
R='\033[0m' B='\033[1m' DIM='\033[2m'
G='\033[32m' Y='\033[33m' C='\033[36m' RED='\033[31m'
TERRA='\033[38;5;173m'  # terracotta orange
PINK='\033[38;5;217m'
GRAY='\033[38;5;240m'

info()  { printf "${C}${B}>>>${R} %s\n" "$*"; }
ok()    { printf "${G}${B} ✓${R} %s\n" "$*"; }
warn()  { printf "${Y}${B} !${R} %s\n" "$*"; }
fail()  { printf "${RED}${B} ✗${R} %s\n" "$*"; exit 1; }

# ── ASCII Art ───────────────────────────────────────────────────────────
show_banner() {
  printf "${TERRA}"
  cat << 'BANNER'

       ██████████████
     ██░░░░░░░░░░░░░░██
     ██░░██░░░░░░██░░██
     ██░░██░░░░░░██░░██
     ██░░░░░░░░░░░░░░██
     ██░░░░████░░░░░░██
       ██████████████
           ██  ██
BANNER
  printf "${R}"
  echo ""
  printf "${TERRA}${B}       ALL DAY POKE${R}\n"
  printf "${GRAY}    claude usage tracker${R}\n"
  echo ""
}

# ── Loading hints (game-style tips) ─────────────────────────────────────
HINTS=(
  "did you know?  the robot's eyes glow white when claude is active"
  "tip: scroll wheel over the robot to resize it"
  "did you know?  you can poke friends and their robot does a head-pat animation"
  "tip: right-click the robot for settings, rankings, and social features"
  "did you know?  the app detects all your claude code sessions automatically"
  "tip: drag the robot anywhere on screen — it floats above all windows"
  "did you know?  usage bars turn yellow at 80% and red at 95%"
  "tip: add friends via invite codes to see who's coding right now"
  "did you know?  the robot vibrates and glows during active API calls"
  "tip: check the leaderboard to see the top 50 users globally"
  "did you know?  the app tracks per-project token usage automatically"
  "tip: hover over the robot to see live stats and session info"
)

show_hint() {
  local idx=$((RANDOM % ${#HINTS[@]}))
  printf "\r\033[K  ${DIM}${PINK}%s${R}" "${HINTS[$idx]}"
}

# Animated progress with rotating hints
# Usage: progress_with_hints <pid_of_background_process>
progress_with_hints() {
  local pid=$1
  local spin='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
  local i=0
  local hint_timer=0

  # Show first hint
  show_hint
  echo ""

  while kill -0 "$pid" 2>/dev/null; do
    local si=$((i % ${#spin}))
    printf "\r  ${TERRA}${spin:$si:1}${R} ${DIM}installing...${R} "
    i=$((i + 1))
    hint_timer=$((hint_timer + 1))

    # Rotate hint every ~3 seconds (30 iterations at 0.1s)
    if [[ $hint_timer -ge 30 ]]; then
      hint_timer=0
      # Move up one line, clear, show new hint, move back down
      printf "\033[1A"
      show_hint
      printf "\n"
    fi

    sleep 0.1
  done

  # Clear the spinner line and hint line
  printf "\r\033[K"
  printf "\033[1A\r\033[K"
}

# ── Pre-flight checks ──────────────────────────────────────────────────
clear
show_banner

# Check OS (macOS only for now)
if [[ "$(uname)" != "Darwin" ]]; then
  fail "All Day Poke currently supports macOS only."
fi

if ! command -v curl &>/dev/null; then
  fail "curl is required."
fi

ok "macOS detected"

# ── Download latest release ─────────────────────────────────────────────

info "Fetching latest release..."

# Get the latest .dmg URL from GitHub Releases
DMG_URL=$(curl -sSL "https://api.github.com/repos/${GITHUB_REPO}/releases/latest" 2>/dev/null \
  | grep -o '"browser_download_url": *"[^"]*\.dmg"' \
  | head -1 \
  | sed 's/"browser_download_url": *"//' \
  | sed 's/"$//' || true)

if [[ -z "$DMG_URL" ]]; then
  warn "No .dmg found in latest release. Falling back to source install..."

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

# ── Download with animated hints ────────────────────────────────────────

TMPDIR_DL=$(mktemp -d)
DMG_FILE="$TMPDIR_DL/AllDayPoke.dmg"

info "Downloading..."
echo ""

# Download in background so we can show hints
curl -fSL -o "$DMG_FILE" "$DMG_URL" 2>/dev/null &
CURL_PID=$!
progress_with_hints $CURL_PID
wait $CURL_PID || fail "Download failed."

ok "Downloaded $(du -h "$DMG_FILE" | cut -f1 | xargs)"

# ── Mount and install ───────────────────────────────────────────────────

info "Installing..."
echo ""

# Run install in background for hints animation
(
  MOUNT_POINT=$(hdiutil attach "$DMG_FILE" -nobrowse -mountpoint "$TMPDIR_DL/mnt" 2>/dev/null | grep -o '/Volumes/.*' | head -1)
  [[ -z "$MOUNT_POINT" ]] && MOUNT_POINT="$TMPDIR_DL/mnt"

  APP_SRC=$(find "$MOUNT_POINT" -maxdepth 1 -name "*.app" -print -quit 2>/dev/null)
  if [[ -z "$APP_SRC" ]]; then
    hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null || true
    rm -rf "$TMPDIR_DL"
    exit 1
  fi

  [[ -d "$INSTALL_DIR/$APP_NAME" ]] && rm -rf "$INSTALL_DIR/$APP_NAME"
  cp -R "$APP_SRC" "$INSTALL_DIR/"
  hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null || true
  rm -rf "$TMPDIR_DL"
  xattr -rd com.apple.quarantine "$INSTALL_DIR/$APP_NAME" 2>/dev/null || true
) &
INSTALL_PID=$!
progress_with_hints $INSTALL_PID
wait $INSTALL_PID || fail "Installation failed. Could not find .app in DMG."

ok "Installed to /Applications"

# ── Auto-launch the app ────────────────────────────────────────────────

echo ""
printf "${TERRA}${B}  ┌─────────────────────────────────────┐${R}\n"
printf "${TERRA}${B}  │                                     │${R}\n"
printf "${TERRA}${B}  │     All Day Poke is ready! ${G}${B}🦀${TERRA}${B}       │${R}\n"
printf "${TERRA}${B}  │                                     │${R}\n"
printf "${TERRA}${B}  └─────────────────────────────────────┘${R}\n"
echo ""

info "Launching All Day Poke..."
open "/Applications/$APP_NAME"
ok "App launched!"

# ── Onboarding tips ─────────────────────────────────────────────────────

echo ""
printf "${GRAY}  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄${R}\n"
echo ""
printf "${B}  Getting started:${R}\n"
echo ""
printf "  ${TERRA}1.${R} Sign up in the app window that just opened\n"
printf "  ${TERRA}2.${R} The robot will appear on your desktop — that's your buddy!\n"
printf "  ${TERRA}3.${R} Start a Claude Code session and watch it light up\n"
echo ""
printf "${GRAY}  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄${R}\n"
echo ""
printf "${B}  Good to know:${R}\n"
echo ""
printf "  ${DIM}•${R} The app starts automatically when you log in\n"
printf "  ${DIM}•${R} Right-click the robot for all settings and features\n"
printf "  ${DIM}•${R} Hover to see live usage stats, drag to reposition\n"
printf "  ${DIM}•${R} Share invite codes with friends to poke each other!\n"
echo ""
printf "${GRAY}  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄${R}\n"
echo ""
printf "  ${DIM}Next time, All Day Poke will start on its own.${R}\n"
printf "  ${DIM}To launch manually:  ${C}open '/Applications/All Day Poke.app'${R}\n"
echo ""
