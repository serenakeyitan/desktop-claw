#!/usr/bin/env python3

import subprocess
import pexpect
import json
import os
import re
from datetime import datetime, timedelta
import sys

def fetch_usage_with_pexpect():
    """Use pexpect to interact with Claude Code"""
    try:
        print("Starting Claude Code session...")

        # Spawn Claude Code
        child = pexpect.spawn('claude', timeout=10)

        # Wait for prompt (various possible patterns)
        patterns = [
            r'desktop_bot.*>',
            r'How can I help',
            r'claude>',
            r'>',
            pexpect.EOF,
            pexpect.TIMEOUT
        ]

        index = child.expect(patterns)

        if index in [4, 5]:  # EOF or TIMEOUT
            print("Failed to get Claude prompt")
            return None

        print("Claude session started, sending /usage command...")

        # Send /usage command
        child.sendline('/usage')

        # Wait for response
        child.expect([r'.*%.*', pexpect.TIMEOUT], timeout=5)

        # Get the output
        output = child.before.decode('utf-8', errors='ignore') + child.after.decode('utf-8', errors='ignore')

        # Exit Claude
        child.sendline('exit')
        child.close()

        return output

    except Exception as e:
        print(f"pexpect error: {e}")
        return None

def fetch_usage_with_subprocess():
    """Try using subprocess with stdin/stdout"""
    try:
        print("Trying subprocess method...")

        # Create process
        proc = subprocess.Popen(
            ['claude'],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True
        )

        # Send /usage command
        output, errors = proc.communicate(input='/usage\nexit\n', timeout=10)

        return output

    except Exception as e:
        print(f"subprocess error: {e}")
        return None

def fetch_usage_with_script():
    """Use AppleScript to control Terminal (macOS specific)"""
    try:
        print("Trying AppleScript method...")

        script = '''
        tell application "Terminal"
            set newTab to do script "claude"
            delay 2
            do script "/usage" in newTab
            delay 2
            set output to contents of newTab
            do script "exit" in newTab
            delay 1
            close newTab
            return output
        end tell
        '''

        result = subprocess.run(
            ['osascript', '-e', script],
            capture_output=True,
            text=True,
            timeout=10
        )

        return result.stdout

    except Exception as e:
        print(f"AppleScript error: {e}")
        return None

def parse_usage(output):
    """Parse usage percentage from Claude output"""
    if not output:
        return None

    print(f"Parsing output (first 500 chars): {output[:500]}")

    # Look for usage patterns
    patterns = [
        r'5-hour:\s*(\d+)%',
        r'Model usage:\s*(\d+)%',
        r'Usage:\s*(\d+)%',
        r'Current usage:\s*(\d+)%',
        r'(\d+)%\s*(?:used|of)',
        r'(\d+)%'  # Any percentage
    ]

    for pattern in patterns:
        match = re.search(pattern, output, re.IGNORECASE)
        if match:
            percentage = int(match.group(1))
            print(f"Found usage: {percentage}%")
            return percentage

    return None

def save_usage(percentage):
    """Save usage data to file"""
    home = os.path.expanduser('~')
    dir_path = os.path.join(home, '.openclaw-pet')
    file_path = os.path.join(dir_path, 'real-usage.json')

    # Create directory if it doesn't exist
    os.makedirs(dir_path, exist_ok=True)

    # Create usage data
    reset_at = datetime.now() + timedelta(hours=5)

    usage_data = {
        'percentage': percentage,
        'used': percentage,
        'limit': 100,
        'resetAt': reset_at.isoformat(),
        'subscription': 'Claude Pro',
        'type': '5-hour',
        'realData': True,
        'timestamp': datetime.now().isoformat(),
        'source': 'auto-fetch from Claude Code (Python)'
    }

    # Save to file
    with open(file_path, 'w') as f:
        json.dump(usage_data, f, indent=2)

    print(f"✅ Usage updated to {percentage}%")
    print(f"📁 Saved to: {file_path}")
    print(f"⏰ Reset at: {reset_at}")

    return usage_data

def main():
    """Main function"""
    output = None

    # Check if pexpect is available
    try:
        import pexpect
        output = fetch_usage_with_pexpect()
    except ImportError:
        print("pexpect not available, trying other methods...")

    # Try other methods if pexpect failed
    if not output:
        output = fetch_usage_with_subprocess()

    if not output and sys.platform == 'darwin':
        output = fetch_usage_with_script()

    if not output:
        print("❌ Failed to fetch usage. Make sure Claude Code is installed and you're logged in.")
        print("Try running 'claude' manually first.")
        return False

    # Parse the usage
    percentage = parse_usage(output)

    if percentage is not None:
        save_usage(percentage)
        print("\n🤖 OpenClaw Pet will now show your real usage!")
        return True
    else:
        print("❌ Could not parse usage from output")
        return False

if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1)