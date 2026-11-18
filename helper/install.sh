#!/bin/zsh
# Installs the Antilibrary helper as a login item and adds the `antilibrary-helper` command.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.antilibrary.helper"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGS="$HOME/Library/Logs/Antilibrary"
mkdir -p "$HOME/Library/LaunchAgents" "$LOGS" "$HOME/.local/bin"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$HERE/service.sh</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$LOGS/helper.log</string>
  <key>StandardErrorPath</key><string>$LOGS/helper.log</string>
</dict></plist>
PL
cat > "$HOME/.local/bin/antilibrary-helper" <<CMD
#!/bin/zsh
# antilibrary-helper start|stop|restart|status|logs
L="gui/\$(id -u)/$LABEL"
case "\$1" in
  start)   launchctl bootstrap "gui/\$(id -u)" "$PLIST" 2>/dev/null || launchctl kickstart "\$L" ;;
  stop)    launchctl bootout "\$L" 2>/dev/null; echo stopped ;;
  restart) launchctl kickstart -k "\$L" ;;
  logs)    tail -n 40 -f "$LOGS/helper.log" ;;
  status|*) curl -s -H "Origin: http://localhost:8731" -H "X-Antilibrary: 1" http://127.0.0.1:8749/status && echo || echo "not running" ;;
esac
CMD
chmod +x "$HOME/.local/bin/antilibrary-helper"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed. The helper starts at login; try: antilibrary-helper status"
