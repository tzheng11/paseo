"""Small primitives shared by staged-runtime packaging and operator cutovers.

These helpers neither start services nor establish retirement/admission authority.
The caller still owns exact process identity and complete listener inspection.
"""
import socket


class PortUnavailable(RuntimeError):
    pass


def assert_port_free(port, listener_pids):
    """Require a complete empty listener read and the same bind mode as Node.

    A drained TCP server can leave TIME_WAIT endpoints. Node uses SO_REUSEADDR;
    a probe without it falsely refuses a port that the replacement can bind.
    This snapshot is not a reservation against a later competing listener.
    """
    if type(port) is not int or not 1 <= port <= 65535:
        raise ValueError("Invalid TCP port")
    listeners = listener_pids()
    if not isinstance(listeners, (list, tuple, set)) or any(
        type(pid) is not int or pid <= 0 for pid in listeners
    ):
        raise PortUnavailable("Listener inspection incomplete; no bootstrap permitted")
    if listeners:
        raise PortUnavailable(f"Port {port} has a listener; no bootstrap permitted")
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind(("127.0.0.1", port))
        except OSError:
            raise PortUnavailable(f"Port {port} cannot be bound; no bootstrap permitted") from None


_ENTRIES = {
    "paseo": "packages/cli/dist/index.js",
    "paseo-server": "packages/server/dist/scripts/supervisor-entrypoint.js",
}


def render_wrapper(command):
    """Resolve the invoked link before choosing the packet's Node and runtime.

    readlink -f is unavailable on supported macOS hosts. Resolve one link at a
    time against its physical parent, including relative and multihop installs.
    """
    if command not in _ENTRIES:
        raise ValueError("Unknown staged runtime command")
    return r'''#!/bin/sh
set -eu
fail() { printf '%s\n' "staged runtime: $1" >&2; exit 1; }
STAGE_SOURCE=$0
case "$STAGE_SOURCE" in
  */*) ;;
  *) STAGE_SOURCE=$(command -v "$STAGE_SOURCE") || fail 'cannot resolve command';;
esac
case "$STAGE_SOURCE" in */*) ;; *) STAGE_SOURCE=./$STAGE_SOURCE;; esac
STAGE_LINKS=0
while :; do
  STAGE_BIN_DIR=$(CDPATH= cd -P -- "${STAGE_SOURCE%/*}" && pwd -P) || fail 'cannot resolve directory'
  STAGE_SOURCE=$STAGE_BIN_DIR/${STAGE_SOURCE##*/}
  [ -L "$STAGE_SOURCE" ] || break
  [ "$STAGE_LINKS" -lt 40 ] || fail 'too many symbolic links'
  STAGE_LINKS=$((STAGE_LINKS + 1))
  STAGE_TARGET=$(/usr/bin/readlink "$STAGE_SOURCE") || fail 'cannot read symbolic link'
  case "$STAGE_TARGET" in
    /*) STAGE_SOURCE=$STAGE_TARGET;;
    *) STAGE_SOURCE=$STAGE_BIN_DIR/$STAGE_TARGET;;
  esac
done
[ -f "$STAGE_SOURCE" ] && [ -x "$STAGE_SOURCE" ] || fail 'missing wrapper target'
[ -x "$STAGE_BIN_DIR/node" ] || fail 'missing packet Node'
[ -f "$STAGE_BIN_DIR/../runtime/''' + _ENTRIES[command] + r'''" ] || fail 'missing packet entrypoint'
PATH="$STAGE_BIN_DIR${PATH:+:$PATH}"
PASEO_CLI="$STAGE_BIN_DIR/paseo"
export PATH PASEO_CLI
exec "$STAGE_BIN_DIR/node" "$STAGE_BIN_DIR/../runtime/''' + _ENTRIES[command] + '''" "$@"
'''


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Render a relocatable staged-runtime wrapper")
    parser.add_argument("command", choices=tuple(_ENTRIES))
    print(render_wrapper(parser.parse_args().command), end="")
