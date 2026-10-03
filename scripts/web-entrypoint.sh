#!/bin/sh
set -e

# runner-web owns a virtual display so browser-backed providers can run Chromium
# headed even on Docker/EasyPanel hosts without a physical X server.
if [ -z "${DISPLAY:-}" ]; then
  export DISPLAY="${OMNIROUTE_WEB_DISPLAY:-:99}"
fi

display_number="${DISPLAY#:}"
display_number="${display_number%%.*}"
socket="/tmp/.X11-unix/X${display_number}"

if [ ! -S "$socket" ]; then
  Xvfb "$DISPLAY" -screen 0 "${OMNIROUTE_WEB_SCREEN:-1280x720x24}" -nolisten tcp \
    >/tmp/omniroute-xvfb.log 2>&1 &
  xvfb_pid=$!

  ready=0
  i=0
  while [ "$i" -lt 50 ]; do
    if [ -S "$socket" ]; then
      ready=1
      break
    fi
    if ! kill -0 "$xvfb_pid" 2>/dev/null; then
      break
    fi
    i=$((i + 1))
    sleep 0.1
  done

  if [ "$ready" -ne 1 ]; then
    echo "ERROR: Xvfb failed to start on $DISPLAY" >&2
    cat /tmp/omniroute-xvfb.log >&2 2>/dev/null || true
    exit 1
  fi

  echo "[runner-web] Xvfb ready on $DISPLAY"
fi

exec /app/check-permissions.sh "$@"
