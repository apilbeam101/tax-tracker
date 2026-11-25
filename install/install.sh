#!/bin/sh
# UK Tax Tracker installer for macOS, and for Linux without a background service.
#
#   curl -fsSL <url>/install.sh | sh
#   curl -fsSL <url>/install.sh | sh -s -- --yes --no-shortcut
#
# What it does: checks for Node.js 24 or later (offering to install it when it is missing, never
# changing one that is already there), installs the uk-tax-tracker package globally, creates the
# configuration with `tax-tracker init`, and on macOS can start the app at login and add a Desktop
# shortcut. It never deletes your data; see --uninstall and --purge.
#
# Everything is defined as functions and only `main "$@"` on the last line does anything, so a
# download that is cut off part-way runs nothing.
set -eu

# Stamped with the release version when the script is attached to a release. Run from a checkout
# it stays a placeholder and the newest published version is installed.
VERSION="__VERSION__"

PACKAGE="uk-tax-tracker"
NODE_MIN_MAJOR=24
# The Node.js installer package used on macOS when Node is missing and Homebrew is not available.
# The checksum is from https://nodejs.org/dist/<version>/SHASUMS256.txt and must be updated with
# the version (see docs/RELEASE_CHECKLIST.md).
NODE_PKG_VERSION="v26.13.0"
NODE_PKG_SHA256="445b202997c959dddbd54ad8c82956371b495b03c73d56044a6f82dfb3249c46"
LABEL="com.apilbeam101.tax-tracker"
CONFIRM_PURGE_WORD="delete my data"

# What the install chose (npm prefix, data folder), so that --uninstall acts on the same things
# without being told again.
STATE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/uk-tax-tracker-installer"
STATE_FILE="$STATE_DIR/state"

PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SHORTCUT="$HOME/Desktop/UK Tax Tracker.webloc"
LOG_DIR="$HOME/Library/Logs/tax-tracker"

ASSUME_YES=0
NO_SERVICE=0
NO_SHORTCUT=0
ALLOW_ROOT=0
PORT=""
DATA_DIR=""
PREFIX=""
FROM_TARBALL=""
DO_UNINSTALL=0
DO_PURGE=0
TMP_DIR=""
CLI=""
OS=""
URL=""

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Options:
  --version <x.y.z>      Install this version (default: the version this script belongs to)
  -y, --yes              Accept the default answer to every question
  --no-service           Do not start the app at login (macOS)
  --no-shortcut          Do not add a Desktop shortcut (macOS)
  --port <n>             Port for the app (default 3000)
  --data-dir <path>      Where the database and config file live (default: per-user location)
  --prefix <dir>         npm global prefix to install into (default: npm's own, or ~/.local when
                         that is not writable by you)
  --from-tarball <file>  Install a packed tarball instead of the published package
  --allow-root           Run as root (the data and service then belong to root)
  --uninstall            Remove the service, shortcut and package; keeps your data
  --purge                With --uninstall: also delete the data directory, after a typed confirmation
  -h, --help
EOF
}

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then rm -rf "$TMP_DIR"; fi
}

# Prompts read from the terminal, not stdin: with `curl | sh` stdin is the script itself.
have_tty() {
  if [ -t 0 ]; then return 0; fi
  if [ -r /dev/tty ] && (: </dev/tty) 2>/dev/null; then return 0; fi
  return 1
}

read_answer() {
  ANSWER=""
  if [ -t 0 ]; then
    read -r ANSWER || ANSWER=""
  elif have_tty; then
    read -r ANSWER </dev/tty || ANSWER=""
  fi
}

# confirm <question> <y|n>: succeeds for yes. --yes and a missing terminal both take the default.
confirm() {
  _question=$1
  _default=$2
  if [ "$ASSUME_YES" = 1 ] || ! have_tty; then
    [ "$_default" = y ]
    return
  fi
  if [ "$_default" = y ]; then _hint="[Y/n]"; else _hint="[y/N]"; fi
  printf '%s %s ' "$_question" "$_hint"
  read_answer
  case "$ANSWER" in
    [Yy]*) return 0 ;;
    [Nn]*) return 1 ;;
    *) [ "$_default" = y ] ;;
  esac
}

# --- state -----------------------------------------------------------------------------------

state_get() {
  if [ -f "$STATE_FILE" ]; then
    sed -n "s/^$1=//p" "$STATE_FILE" | head -n 1
  fi
}

write_state() {
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR"
  {
    printf 'prefix=%s\n' "$PREFIX"
    printf 'data_dir=%s\n' "$1"
  } >"$STATE_FILE"
  chmod 600 "$STATE_FILE"
}

# --- Node.js ---------------------------------------------------------------------------------

node_major() {
  node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0
}

install_node_macos() {
  if command -v brew >/dev/null 2>&1; then
    say "Installing Node.js with Homebrew..."
    brew install node
    return
  fi
  say "Installing Node.js $NODE_PKG_VERSION from nodejs.org (the installer asks for your password)..."
  TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/tax-tracker-install.XXXXXX")
  curl -fsSL -o "$TMP_DIR/node.pkg" "https://nodejs.org/dist/$NODE_PKG_VERSION/node-$NODE_PKG_VERSION.pkg"
  # The checksum is checked on a copy in a folder only root can write to, so the file that is
  # verified is the file that is installed.
  _rootdir=$(sudo mktemp -d /var/tmp/tax-tracker-node.XXXXXX)
  sudo cp "$TMP_DIR/node.pkg" "$_rootdir/node.pkg"
  _actual=$(sudo shasum -a 256 "$_rootdir/node.pkg" | cut -d ' ' -f 1)
  if [ "$_actual" != "$NODE_PKG_SHA256" ]; then
    sudo rm -rf "$_rootdir"
    die "the downloaded Node.js package does not match its expected checksum; nothing was installed"
  fi
  sudo installer -pkg "$_rootdir/node.pkg" -target /
  sudo rm -rf "$_rootdir"
}

ensure_node() {
  if command -v node >/dev/null 2>&1; then
    _major=$(node_major)
    if [ "$_major" -lt "$NODE_MIN_MAJOR" ]; then
      die "Node.js $(node --version) is installed, but $NODE_MIN_MAJOR or later is needed. This installer never changes an existing Node.js; upgrade it yourself and run this again."
    fi
    return
  fi
  if [ "$OS" != "Darwin" ]; then
    die "Node.js $NODE_MIN_MAJOR or later is needed and was not found. Install it from https://nodejs.org or your package manager, then run this again."
  fi
  if [ "$ASSUME_YES" != 1 ] && ! have_tty; then
    die "Node.js $NODE_MIN_MAJOR or later is needed. Run again with --yes to let this installer install it."
  fi
  confirm "Node.js $NODE_MIN_MAJOR or later was not found. Install it now?" y || die "Node.js is required"
  install_node_macos
  PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
  export PATH
  hash -r 2>/dev/null || true
  command -v node >/dev/null 2>&1 || die "Node.js was installed but is not on PATH; open a new terminal and run this again"
  [ "$(node_major)" -ge "$NODE_MIN_MAJOR" ] || die "the installed Node.js is older than $NODE_MIN_MAJOR"
}

# --- npm and the installed command -----------------------------------------------------------

npm_global() {
  if [ -n "$PREFIX" ]; then
    npm "$@" -g --prefix "$PREFIX"
  else
    npm "$@" -g
  fi
}

# A system Node (the nodejs.org installer, a Linux package) leaves npm's global folder owned by
# root. Install into the user's own folder then, instead of failing or asking for sudo.
choose_prefix() {
  if [ -n "$PREFIX" ]; then return 0; fi
  _global=$(npm prefix -g 2>/dev/null) || return 0
  _target="$_global/lib/node_modules"
  if [ ! -d "$_target" ]; then _target="$_global"; fi
  if [ ! -w "$_target" ]; then
    PREFIX="$HOME/.local"
    say "npm's global folder ($_global) is not writable by you, so the package goes under $PREFIX."
  fi
}

package_cli() {
  printf '%s/%s/dist/server/cli.js' "$(npm_global root)" "$PACKAGE"
}

# Runs the installed command the way the background service runs it: from /, with nothing in the
# caller's environment that changes where the data lives. Otherwise a ./data folder in the current
# directory, or a DATA_DIR/DB_PATH in the shell, would make init and uninstall act on a different
# folder from the one the service uses.
run_cli() {
  (
    unset DB_PATH DATA_DIR AUTO_CONFIG SESSION_SECRET SESSION_SECRET_FILE
    cd / || exit 1
    node "$CLI" "$@"
  )
}

data_dir_from() {
  # Reads "Data directory: <dir> (from <source>)" from init or info output.
  sed -n 's/^Data directory:[[:space:]]*//p' | head -n 1 | sed 's/ (from [^)]*)$//'
}

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

# Escapes a value for use as the replacement in `sed "s#...#value#"`.
sed_escape() {
  printf '%s' "$1" | sed -e 's/[\\&#]/\\&/g'
}

# --- launchd (macOS) -------------------------------------------------------------------------

write_plist() {
  _node=$1
  _cli=$2
  mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"
  chmod 700 "$LOG_DIR"
  _node_x=$(sed_escape "$(xml_escape "$_node")")
  _cli_x=$(sed_escape "$(xml_escape "$_cli")")
  _log_x=$(sed_escape "$(xml_escape "$LOG_DIR")")
  _extra=""
  if [ -n "$PORT" ]; then _extra="$_extra		<string>--port</string>
		<string>$PORT</string>
"; fi
  if [ -n "$DATA_DIR" ]; then _extra="$_extra		<string>--data-dir</string>
		<string>$(xml_escape "$DATA_DIR")</string>
"; fi
  # Keep this in step with deploy/launchd/com.apilbeam101.tax-tracker.plist (a test compares them).
  cat >"$PLIST.template" <<'PLIST_EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>com.apilbeam101.tax-tracker</string>

	<key>ProgramArguments</key>
	<array>
		<string>__NODE__</string>
		<string>__CLI__</string>
		<string>start</string>
	</array>

	<key>RunAtLoad</key>
	<true/>

	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>10</integer>

	<key>EnvironmentVariables</key>
	<dict>
		<key>NODE_ENV</key>
		<string>production</string>
		<key>RESTORE_RESTART</key>
		<string>exit</string>
		<key>LOG_LEVEL</key>
		<string>warn</string>
	</dict>

	<key>Umask</key>
	<integer>63</integer>

	<key>StandardOutPath</key>
	<string>__LOG_DIR__/tax-tracker.log</string>
	<key>StandardErrorPath</key>
	<string>__LOG_DIR__/tax-tracker.log</string>
</dict>
</plist>
PLIST_EOF
  : >"$PLIST"
  chmod 600 "$PLIST"
  while IFS= read -r _line; do
    printf '%s\n' "$_line" | sed -e "s#__NODE__#$_node_x#g" -e "s#__CLI__#$_cli_x#g" -e "s#__LOG_DIR__#$_log_x#g" >>"$PLIST"
    case "$_line" in
      *'<string>start</string>'*) printf '%s' "$_extra" >>"$PLIST" ;;
    esac
  done <"$PLIST.template"
  rm -f "$PLIST.template"
  plutil -lint "$PLIST" >/dev/null || die "the generated launchd file is not valid: $PLIST"
}

launchd_domain() { printf 'gui/%s' "$(id -u)"; }

launchd_stop() {
  launchctl bootout "$(launchd_domain)/$LABEL" 2>/dev/null ||
    launchctl unload "$PLIST" 2>/dev/null || true
}

launchd_start() {
  if launchctl bootstrap "$(launchd_domain)" "$PLIST" 2>/dev/null; then return 0; fi
  launchctl load -w "$PLIST" 2>/dev/null
}

# Something else may already answer on the port, so the answer has to be this app's.
wait_for_health() {
  _tries=0
  while [ "$_tries" -lt 30 ]; do
    if curl -fsS "$URL/health" 2>/dev/null | grep -q '"status":"ok"'; then return 0; fi
    _tries=$((_tries + 1))
    sleep 1
  done
  return 1
}

write_shortcut() {
  [ -d "$HOME/Desktop" ] || return 1
  cat >"$SHORTCUT" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>URL</key>
	<string>$URL</string>
</dict>
</plist>
EOF
}

# --- uninstall -------------------------------------------------------------------------------

# Only a folder that holds this app's files, that is not the home folder or one of its parents,
# and that is not at the top of the tree.
safe_to_purge() {
  _p=$1
  case "$_p" in
    /*) ;;
    *) return 1 ;;
  esac
  if [ ! -f "$_p/taxtracker.db" ] && [ ! -f "$_p/config.json" ]; then return 1; fi
  case "$HOME/" in
    "$_p"/*) return 1 ;;
  esac
  _depth=$(printf '%s' "$_p" | tr -cd '/' | wc -c)
  [ "$_depth" -ge 2 ]
}

do_uninstall() {
  if [ -z "$PREFIX" ]; then PREFIX=$(state_get prefix); fi
  _data=$DATA_DIR
  if [ -z "$_data" ]; then _data=$(state_get data_dir); fi
  if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
    CLI=$(package_cli)
    if [ -z "$_data" ] && [ -f "$CLI" ]; then
      _data=$(run_cli info 2>/dev/null | data_dir_from || true)
    fi
  fi
  if [ "$OS" = "Darwin" ]; then
    launchd_stop
    rm -f "$PLIST" "$SHORTCUT"
  fi
  if command -v npm >/dev/null 2>&1; then
    npm_global uninstall "$PACKAGE" >/dev/null 2>&1 || warn "could not remove the $PACKAGE package; remove it with: npm uninstall -g $PACKAGE"
  fi
  rm -f "$STATE_FILE"
  rmdir "$STATE_DIR" 2>/dev/null || true
  say "Removed the service, shortcut and package."
  if [ -z "$_data" ]; then
    say "Your data was not touched."
    return
  fi
  if [ "$DO_PURGE" != 1 ]; then
    say "Your data is still in $_data (delete it yourself, or run the installer with --uninstall --purge)."
    return
  fi
  if ! safe_to_purge "$_data"; then
    die "refusing to delete '$_data': it does not look like a UK Tax Tracker data folder, or it is too broad. Your data was not deleted."
  fi
  if ! have_tty; then die "--purge needs a terminal for its confirmation; your data was not deleted"; fi
  printf 'This permanently deletes %s, including every backup in it.\nType "%s" to confirm: ' "$_data" "$CONFIRM_PURGE_WORD"
  read_answer
  if [ "$ANSWER" = "$CONFIRM_PURGE_WORD" ]; then
    rm -rf "$_data"
    say "Deleted $_data."
  else
    say "Cancelled. Your data was not deleted."
  fi
}

# --- install ---------------------------------------------------------------------------------

do_install() {
  ensure_node
  NODE_BIN=$(node -p process.execPath)
  choose_prefix

  if [ -n "$FROM_TARBALL" ]; then
    [ -f "$FROM_TARBALL" ] || die "no such file: $FROM_TARBALL"
    _dir=$(cd "$(dirname "$FROM_TARBALL")" && pwd)
    SPEC="$_dir/$(basename "$FROM_TARBALL")"
  else
    SPEC="$PACKAGE@$VERSION"
  fi

  say "Installing $SPEC ..."
  if ! _out=$(npm_global install --no-audit --no-fund "$SPEC" 2>&1); then
    printf '%s\n' "$_out" >&2
    die "npm could not install $SPEC"
  fi

  CLI=$(package_cli)
  [ -f "$CLI" ] || die "the package installed, but $CLI is missing"

  if [ -n "$DATA_DIR" ]; then
    INIT_OUT=$(run_cli init --data-dir "$DATA_DIR")
  else
    INIT_OUT=$(run_cli init)
  fi
  say "$INIT_OUT"
  ACTUAL_DATA=$(printf '%s\n' "$INIT_OUT" | data_dir_from)
  write_state "$ACTUAL_DATA"

  SERVICE_STARTED=0
  if [ "$OS" = "Darwin" ] && [ "$NO_SERVICE" != 1 ]; then
    if confirm "Start UK Tax Tracker automatically when you log in?" y; then
      write_plist "$NODE_BIN" "$CLI"
      launchd_stop
      if launchd_start; then
        if wait_for_health; then
          SERVICE_STARTED=1
          say "UK Tax Tracker is running at $URL"
        else
          warn "the service was loaded but $URL/health did not answer; see $LOG_DIR/tax-tracker.log"
        fi
      else
        warn "launchd would not load $PLIST; start the app yourself with: tax-tracker start"
      fi
    fi
  fi

  if [ "$OS" = "Darwin" ] && [ "$NO_SHORTCUT" != 1 ]; then
    if confirm "Add a Desktop shortcut that opens the app?" y; then
      write_shortcut || warn "could not create the Desktop shortcut"
    fi
  fi

  say ""
  say "Installed UK Tax Tracker $(run_cli --version)."
  say "  Data folder:  $ACTUAL_DATA"
  say "  Backups:      $ACTUAL_DATA/backups (a daily backup is on by default)"
  if [ "$SERVICE_STARTED" = 1 ]; then
    say "  Open:         $URL"
  else
    say "  Start it:     tax-tracker start --open"
  fi
  if [ -n "$PREFIX" ]; then
    say "  Command:      $PREFIX/bin/tax-tracker (add $PREFIX/bin to your PATH to run it as tax-tracker)"
  fi
  if [ -n "$DATA_DIR" ]; then
    say "  Note:         pass --data-dir \"$ACTUAL_DATA\" to tax-tracker commands you run yourself, or they use the default folder."
  fi
  say "  Uninstall:    run this installer again with --uninstall (your data is kept unless you add --purge)"
  say ""
  say "On first start you create your account and are shown a recovery key. Store it somewhere other"
  say "than this computer: it is the only way back in if you forget your passphrase."
  if [ "$OS" = "Linux" ]; then
    say "Linux: to run it as a service see the systemd unit in deploy/systemd of the repository."
  fi
}

main() {
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  while [ $# -gt 0 ]; do
    case "$1" in
      --version) VERSION=${2:?--version needs a value}; shift 2 ;;
      -y | --yes) ASSUME_YES=1; shift ;;
      --no-service) NO_SERVICE=1; shift ;;
      --no-shortcut) NO_SHORTCUT=1; shift ;;
      --port) PORT=${2:?--port needs a value}; shift 2 ;;
      --data-dir) DATA_DIR=${2:?--data-dir needs a value}; shift 2 ;;
      --prefix) PREFIX=${2:?--prefix needs a value}; shift 2 ;;
      --from-tarball) FROM_TARBALL=${2:?--from-tarball needs a value}; shift 2 ;;
      --allow-root) ALLOW_ROOT=1; shift ;;
      --uninstall) DO_UNINSTALL=1; shift ;;
      --purge) DO_PURGE=1; shift ;;
      -h | --help) usage; exit 0 ;;
      *) usage >&2; die "unknown option: $1" ;;
    esac
  done

  case "$VERSION" in __*) VERSION="latest" ;; esac

  if [ -n "$PORT" ]; then
    case "$PORT" in
      *[!0-9]* | '') die "--port must be a number between 1 and 65535" ;;
    esac
    if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then die "--port must be a number between 1 and 65535"; fi
  fi
  if [ "$DO_PURGE" = 1 ] && [ "$DO_UNINSTALL" = 0 ]; then die "--purge only goes with --uninstall"; fi
  if [ -n "$DATA_DIR" ]; then
    case "$DATA_DIR" in
      /*) ;;
      *) DATA_DIR="$(pwd)/$DATA_DIR" ;;
    esac
  fi

  OS=$(uname -s)
  case "$OS" in
    Darwin | Linux) ;;
    *) die "this installer supports macOS and Linux; on Windows use install.ps1" ;;
  esac

  if [ "$(id -u)" = 0 ] && [ "$ALLOW_ROOT" != 1 ]; then
    die "do not run this as root (or with sudo): the app, its data and its service would belong to root. Run it as your own user; it asks for your password itself only when it needs it. Use --allow-root if you really mean it."
  fi

  URL="http://127.0.0.1:${PORT:-3000}"

  if [ "$DO_UNINSTALL" = 1 ]; then
    do_uninstall
  else
    do_install
  fi
}

main "$@"
