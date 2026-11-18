#!/bin/zsh
# Started by macOS at login (see ~/Library/LaunchAgents/com.antilibrary.helper.plist).
# A background app doesn't read your shell settings, so set up what the helper needs here.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
# The Claude API key from ~/.zshrc (just that line), used only for difficulty scores.
eval "$(grep -E '^export ANTHROPIC_API_KEY=' "$HOME/.zshrc" | tail -1)"
cd "$(dirname "$0")" && exec uv run server.py
