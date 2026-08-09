#!/usr/bin/env bash
set -euo pipefail

SCRIPT_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_ROOT="$(cd "$SCRIPT_LIB_DIR/../.." && pwd)"
export REPOSITORY_ROOT

sanitize_shell_environment() {
  while IFS= read -r environment_name; do
    normalized_name="$(printf '%s' "$environment_name" | tr '[:lower:]' '[:upper:]')"
    case "$normalized_name" in
      PATH|PWD|OLDPWD|SHLVL|_|OFFLINE|REPOSITORY_ROOT|SOURCE_DATE_EPOCH|\
      SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|OS|SYSTEMDRIVE|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|\
      PROCESSOR_ARCHITECTURE|PROCESSOR_IDENTIFIER|NUMBER_OF_PROCESSORS|\
      HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|\
      NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|\
      DICEKEYS_BUILD_OFFLINE|DICEKEYS_RELEASE_BUILD|DICEKEYS_BUILD_RELEASE_OFFLINE|\
      DICEKEYS_BUILD_RELEASE_ALLOW_DIRTY_EVALUATION|DICEKEYS_BUILD_RELEASE_SOURCE_STATE_SHA256)
        ;;
      *)
        unset "$environment_name" 2>/dev/null || true
        ;;
    esac
  done < <(compgen -e)

  export HOME="$REPOSITORY_ROOT/.cache/home"
  export USERPROFILE="$HOME"
  export APPDATA="$HOME/AppData/Roaming"
  export LOCALAPPDATA="$HOME/AppData/Local"
  export TEMP="$REPOSITORY_ROOT/.cache/tmp"
  export TMP="$TEMP"
  export TMPDIR="$TEMP"
  export XDG_CACHE_HOME="$REPOSITORY_ROOT/.cache/xdg"
  export XDG_CONFIG_HOME="$REPOSITORY_ROOT/.cache/xdg-config"
  export CI=true
  export NO_UPDATE_NOTIFIER=1
  export LC_ALL=C
  export LANG=C
  export TZ=UTC
}

configure_build_environment() {
  sanitize_shell_environment
  node "$REPOSITORY_ROOT/scripts/initialize-build-cache.mjs"
  export CSC_IDENTITY_AUTO_DISCOVERY=false
  export npm_config_ignore_scripts=false
  export CI=true
  export NO_UPDATE_NOTIFIER=1
  export npm_config_userconfig="$REPOSITORY_ROOT/.cache/npmrc-user-empty"
  export npm_config_globalconfig="$REPOSITORY_ROOT/.cache/npmrc-global-empty"
  export npm_config_registry="https://registry.npmjs.org/"
  export npm_config_cache="$REPOSITORY_ROOT/.cache/npm"
  export npm_config_audit=false
  export npm_config_fund=false
  export npm_config_update_notifier=false
  export electron_config_cache="$REPOSITORY_ROOT/.cache/electron"
  export ELECTRON_CACHE="$REPOSITORY_ROOT/.cache/electron"
  export ELECTRON_BUILDER_CACHE="$REPOSITORY_ROOT/.cache/electron-builder"
  set_offline_environment
}

parse_offline_flag() {
  OFFLINE=false
  if [[ ${1:-} == "--offline" ]]; then
    OFFLINE=true
    shift
  fi
  if (($#)); then
    echo "error: unknown arguments: $*" >&2
    exit 2
  fi
  export OFFLINE
  set_offline_environment
}

set_offline_environment() {
  if [[ ${OFFLINE:-false} == true ]]; then
    export npm_config_offline=true
    export DICEKEYS_BUILD_OFFLINE=true
    unset NPM_CONFIG_OFFLINE || true
  else
    unset npm_config_offline NPM_CONFIG_OFFLINE || true
    export DICEKEYS_BUILD_OFFLINE=false
  fi
}

npm_ci_root() {
  local root="$1"
  local -a flags=(ci --ignore-scripts=false --no-audit --no-fund)
  if [[ $OFFLINE == true ]]; then flags+=(--offline); fi
  npm_cli --prefix "$REPOSITORY_ROOT/$root" "${flags[@]}"
}

npm_cli() {
  node "$REPOSITORY_ROOT/scripts/run-npm.mjs" "$@"
}
