#!/bin/bash

# Test script to get real usage from Claude Code interactively

echo "Testing Claude Code usage fetching..."

# Create a temporary expect script
cat > /tmp/claude_usage.exp << 'EOF'
#!/usr/bin/expect -f

set timeout 10
log_user 1

spawn claude

expect {
    "desktop_bot" {
        send "/usage\r"
    }
    "How can I help" {
        send "/usage\r"
    }
    ">" {
        send "/usage\r"
    }
    timeout {
        puts "Timeout waiting for Claude prompt"
        exit 1
    }
}

expect {
    -re {([0-9]+)%} {
        set percentage $expect_out(1,string)
        puts "\nFOUND_USAGE:$percentage"
    }
    timeout {
        puts "No usage found"
    }
}

send "exit\r"
expect eof
EOF

chmod +x /tmp/claude_usage.exp

# Run the expect script
output=$(/tmp/claude_usage.exp 2>&1)

# Extract the percentage
if [[ $output =~ FOUND_USAGE:([0-9]+) ]]; then
    percentage="${BASH_REMATCH[1]}"
    echo "✅ Found real usage: ${percentage}%"

    # Update the usage file
    node -e "
    const fs = require('fs');
    const path = require('path');
    const os = require('os');

    const file = path.join(os.homedir(), '.openclaw-pet', 'real-usage.json');
    const dir = path.dirname(file);

    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    const data = {
        percentage: ${percentage},
        used: ${percentage},
        limit: 100,
        resetAt: new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString(),
        subscription: 'Claude Pro',
        type: '5-hour',
        realData: true,
        timestamp: new Date().toISOString(),
        source: 'interactive test'
    };

    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    console.log('Updated ~/.openclaw-pet/real-usage.json');
    "
else
    echo "❌ Could not find usage in output"
    echo "Output was:"
    echo "$output" | head -20
fi

# Clean up
rm -f /tmp/claude_usage.exp