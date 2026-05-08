#!/usr/bin/env bash
# Package Syncroll for the Chrome Web Store.
#
# Usage: bash scripts/package.sh
#
# Output: dist/syncroll-<version>.zip — ready to upload at
# https://chrome.google.com/webstore/devconsole

set -euo pipefail

cd "$(dirname "$0")/.."

# ── Files that ship inside the extension ZIP ────────────────────────────────
FILES=(
  manifest.json
  background.js
  content.js
  content-main.js
  popup.html
  popup.js
  icons/icon16.png
  icons/icon48.png
  icons/icon128.png
)

# ── 1. Validate manifest.json ───────────────────────────────────────────────
echo "==> validating manifest.json"
python3 - <<'PY'
import json, sys, pathlib
m = json.loads(pathlib.Path("manifest.json").read_text())

errors = []
if m.get("manifest_version") != 3:
    errors.append("manifest_version must be 3")
for k in ("name", "version", "description"):
    if not m.get(k):
        errors.append(f"missing required field: {k}")

icons = m.get("icons", {})
for size in ("16", "48", "128"):
    p = icons.get(size)
    if not p:
        errors.append(f"icons.{size} not declared")
    elif not pathlib.Path(p).exists():
        errors.append(f"icons.{size} path not found: {p}")

popup = m.get("action", {}).get("default_popup")
if popup and not pathlib.Path(popup).exists():
    errors.append(f"action.default_popup not found: {popup}")

worker = m.get("background", {}).get("service_worker")
if worker and not pathlib.Path(worker).exists():
    errors.append(f"background.service_worker not found: {worker}")

# Web Store hard limits
if len(m.get("name", "")) > 75:
    errors.append("name exceeds 75 chars (Web Store limit)")
if len(m.get("description", "")) > 132:
    errors.append("description exceeds 132 chars (Web Store limit)")

if errors:
    print("\n".join(f"  ✗ {e}" for e in errors), file=sys.stderr)
    sys.exit(1)

print(f"  name        {m['name']}")
print(f"  short_name  {m.get('short_name','(none)')}")
print(f"  version     {m['version']}")
print(f"  permissions {','.join(m.get('permissions',[])) or '(none)'}")
print(f"  hosts       {','.join(m.get('host_permissions',[])) or '(none)'}")
print(f"  desc len    {len(m['description'])}/132")
PY

# ── 2. Verify every shipped file exists ─────────────────────────────────────
echo "==> verifying files"
for f in "${FILES[@]}"; do
  if [[ ! -f "$f" ]]; then
    echo "  ✗ missing: $f" >&2
    exit 1
  fi
done
echo "  ${#FILES[@]} files OK"

# ── 3. Build the ZIP ────────────────────────────────────────────────────────
VERSION=$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")
SLUG="syncroll"
DIST="dist"
ZIP="${DIST}/${SLUG}-${VERSION}.zip"

mkdir -p "$DIST"
rm -f "$ZIP"

echo "==> packaging"
zip -r "$ZIP" "${FILES[@]}" \
  --exclude '*.DS_Store' '*/.*' >/dev/null

# ── 4. Report ───────────────────────────────────────────────────────────────
SIZE=$(stat -f%z "$ZIP" 2>/dev/null || stat -c%s "$ZIP")
SIZE_KB=$(( (SIZE + 1023) / 1024 ))

echo
echo "✓ $ZIP (${SIZE_KB} KB)"
echo
echo "  contents:"
unzip -l "$ZIP" | sed -n '4,/^---/p' | sed '$d' | awk '{printf "    %s\n", $0}'
echo
echo "  upload at: https://chrome.google.com/webstore/devconsole"
