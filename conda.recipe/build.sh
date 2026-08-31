#!/bin/bash
set -euo pipefail

# The Bun/TypeScript build isn't run by rattler-build. Build the platform
# binary first (from the repo root):
#
#   bun run script/with-version.ts bun run --cwd packages/opencode script/build.ts --single --skip-install
#
# then build this recipe with:
#
#   bun run script/with-version.ts rattler-build build --recipe conda.recipe

REPO_ROOT="$(cd "$(dirname "$RECIPE_DIR")" && pwd)"
CLI_DIR="$REPO_ROOT/packages/opencode"

shopt -s nullglob
candidates=("$CLI_DIR"/dist/@kilocode/cli-*/bin/kilo)
shopt -u nullglob

if [ "${#candidates[@]}" -ne 1 ]; then
  echo "FAIL: expected exactly one prebuilt binary at packages/opencode/dist/@kilocode/cli-*/bin/kilo, found ${#candidates[@]}"
  echo "Build it first with:"
  echo "  bun run script/with-version.ts bun run --cwd packages/opencode script/build.ts --single --skip-install"
  exit 1
fi

BINFILE="${candidates[0]}"
BIN_DIR="$(dirname "$BINFILE")"
echo "Binary path: $BINFILE"

if [ ! -x "$BINFILE" ]; then
  echo "FAIL: prebuilt binary is not executable"
  exit 1
fi

actual=$("$BINFILE" --version | head -1)
echo "Version: $actual"
if [ "$actual" != "$PKG_VERSION" ]; then
  echo "FAIL: expected $PKG_VERSION, got $actual"
  exit 1
fi

LIB_DIR="$PREFIX/lib/kilo"
mkdir -p "$PREFIX/bin" "$LIB_DIR"

install -m 755 "$BINFILE" "$LIB_DIR/kilo"

if [ -f "$BIN_DIR/kilo-sandbox-mutation-worker.js" ]; then
  install -m 644 "$BIN_DIR/kilo-sandbox-mutation-worker.js" "$LIB_DIR/kilo-sandbox-mutation-worker.js"
fi

if [ -d "$BIN_DIR/tree-sitter" ]; then
  cp -r "$BIN_DIR/tree-sitter" "$LIB_DIR/tree-sitter"
fi

# Linux-only: bundled bubblewrap sandbox helper, network relay, seccomp filter.
if [ -f "$BIN_DIR/bwrap" ]; then
  install -m 755 "$BIN_DIR/bwrap" "$LIB_DIR/bwrap"
fi
if [ -f "$BIN_DIR/kilo-sandbox-network-relay.js" ]; then
  install -m 644 "$BIN_DIR/kilo-sandbox-network-relay.js" "$LIB_DIR/kilo-sandbox-network-relay.js"
fi
if [ -f "$BIN_DIR/kilo-sandbox-seccomp" ]; then
  install -m 755 "$BIN_DIR/kilo-sandbox-seccomp" "$LIB_DIR/kilo-sandbox-seccomp"
fi
if [ -d "$BIN_DIR/licenses" ]; then
  cp -r "$BIN_DIR/licenses" "$LIB_DIR/licenses"
fi

# The compiled binary resolves the bundled bwrap helper, sandbox worker, and
# network relay relative to its own path (process.execPath), so those stay
# siblings of the real binary in $PREFIX/lib/kilo. The tree-sitter WASM
# directory needs an explicit env var though (same as this project's own
# Homebrew formula and AUR package), so route through a thin wrapper rather
# than symlinking $PREFIX/bin/kilo directly at the real binary.
printf '%s\n' \
  '#!/bin/sh' \
  "export KILO_TREE_SITTER_WASM_DIR=\"$LIB_DIR/tree-sitter\"" \
  "exec \"$LIB_DIR/kilo\" \"\$@\"" \
  > "$PREFIX/bin/kilo"
chmod 755 "$PREFIX/bin/kilo"
ln -sf kilo "$PREFIX/bin/kilocode"
