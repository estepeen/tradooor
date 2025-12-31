#!/bin/bash
set -e

# NINJA Trader Deployment Script
# Run this on your VPS to set up the Rust trading bot

echo "🥷 NINJA Trader Deployment"
echo "=========================="

# Check if running on Linux
if [[ "$OSTYPE" != "linux-gnu"* ]]; then
    echo "❌ This script is meant to run on Linux VPS"
    exit 1
fi

# Install Redis if not present
if ! command -v redis-server &> /dev/null; then
    echo "📦 Installing Redis..."
    apt-get update
    apt-get install -y redis-server
    systemctl enable redis-server
    systemctl start redis-server
fi

# Verify Redis is running
if ! redis-cli ping &> /dev/null; then
    echo "❌ Redis is not running!"
    exit 1
fi
echo "✅ Redis is running"

# Install Rust if not present
if ! command -v cargo &> /dev/null; then
    echo "📦 Installing Rust..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    source ~/.cargo/env
fi

echo "✅ Rust version: $(rustc --version)"

# Build the bot
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "🔨 Building NINJA Trader..."
cargo build --release

BINARY_PATH="$SCRIPT_DIR/target/release/ninja-trader"

if [[ ! -f "$BINARY_PATH" ]]; then
    echo "❌ Build failed - binary not found"
    exit 1
fi

echo "✅ Binary built: $BINARY_PATH ($(du -h "$BINARY_PATH" | cut -f1))"

# Create systemd service
echo "📝 Creating systemd service..."

cat > /etc/systemd/system/ninja-trader.service << EOF
[Unit]
Description=NINJA Trading Bot
After=network.target redis-server.service

[Service]
Type=simple
User=root
WorkingDirectory=$SCRIPT_DIR
ExecStart=$BINARY_PATH
Restart=always
RestartSec=5
Environment=RUST_LOG=info

# Load environment variables
EnvironmentFile=$SCRIPT_DIR/.env

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload

echo ""
echo "✅ NINJA Trader installed!"
echo ""
echo "📋 Next steps:"
echo "   1. Create .env file with your configuration:"
echo "      cp .env.example .env"
echo "      nano .env"
echo ""
echo "   2. Add these to your backend .env:"
echo "      ENABLE_NINJA_BOT=true"
echo "      REDIS_URL=redis://127.0.0.1:6379"
echo ""
echo "   3. Start the bot:"
echo "      systemctl start ninja-trader"
echo "      systemctl status ninja-trader"
echo ""
echo "   4. View logs:"
echo "      journalctl -u ninja-trader -f"
echo ""
echo "   5. Enable auto-start on boot:"
echo "      systemctl enable ninja-trader"
