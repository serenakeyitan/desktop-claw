const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

function fileExists(filePath) {
  try {
    if (!filePath) return false;
    if (!fs.existsSync(filePath)) return false;
    if (process.platform === 'win32') {
      return true;
    }
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveFromPath(cmd) {
  const locator = process.platform === 'win32' ? 'where' : 'which';
  try {
    const result = spawnSync(locator, [cmd], { encoding: 'utf8' });
    if (result.status === 0) {
      const line = (result.stdout || '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.length > 0);
      if (line) {
        return line;
      }
      return cmd;
    }
  } catch {
    return null;
  }
  return null;
}

function findVersionedBinary(rootDir, binaryName) {
  try {
    if (!fs.existsSync(rootDir)) {
      return null;
    }
    const entries = fs.readdirSync(rootDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));

    for (const dir of entries) {
      const candidate = path.join(rootDir, dir, binaryName);
      if (fileExists(candidate)) {
        return candidate;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function getPlatformCandidates(binaryName) {
  if (process.platform === 'darwin') {
    const base = path.join(os.homedir(), 'Library', 'Application Support', 'Claude');
    return [
      findVersionedBinary(path.join(base, 'claude-code'), binaryName),
      findVersionedBinary(path.join(base, 'claude-code-vm'), binaryName)
    ].filter(Boolean);
  }

  if (process.platform === 'linux') {
    const base = path.join(os.homedir(), '.local', 'share', 'Claude');
    return [
      findVersionedBinary(path.join(base, 'claude-code'), binaryName)
    ].filter(Boolean);
  }

  if (process.platform === 'win32') {
    const localApp = path.join(os.homedir(), 'AppData', 'Local');
    const roots = [
      path.join(localApp, 'Programs', 'Claude'),
      path.join(localApp, 'Anthropic', 'Claude')
    ];

    const binaries = [];
    for (const root of roots) {
      const candidate = findVersionedBinary(root, binaryName) ||
        (() => {
          const direct = path.join(root, binaryName);
          return fileExists(direct) ? direct : null;
        })();
      if (candidate) {
        binaries.push(candidate);
      }
    }
    return binaries;
  }

  return [];
}

function getClaudeBinaryPath() {
  const envPath = process.env.CLAUDE_CLI_PATH;
  if (envPath && fileExists(envPath)) {
    return envPath;
  }

  const defaultCmd = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const resolved = resolveFromPath(defaultCmd);
  if (resolved && fileExists(resolved)) {
    return resolved;
  }

  const platformBinaries = getPlatformCandidates(defaultCmd);
  if (platformBinaries.length > 0) {
    return platformBinaries[0];
  }

  throw new Error(
    'Claude CLI not found. Install it (Claude Desktop → Settings → "Install command line tool") ' +
    'or set CLAUDE_CLI_PATH to the full path of the claude binary.'
  );
}

// Check if Claude is authenticated by trying to run a simple command
function checkClaudeAuth() {
  try {
    const claudeBinary = getClaudeBinaryPath();
    const result = spawnSync(claudeBinary, ['/version'], {
      encoding: 'utf8',
      timeout: 5000
    });

    if (result.status === 0) {
      // Check if output contains authentication error messages
      const output = (result.stdout || '') + (result.stderr || '');
      if (output.includes('not authenticated') ||
          output.includes('please login') ||
          output.includes('setup-token')) {
        return { authenticated: false, message: 'Claude CLI requires authentication' };
      }
      return { authenticated: true, message: 'Claude CLI is authenticated' };
    }

    return { authenticated: false, message: 'Claude CLI check failed' };
  } catch (error) {
    return { authenticated: false, message: error.message };
  }
}

module.exports = {
  getClaudeBinaryPath,
  checkClaudeAuth
};
