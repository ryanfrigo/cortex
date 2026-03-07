#!/usr/bin/env bash
# compact-memory.sh — ReMe-inspired MEMORY.md compaction & archival
# Checks size, analyzes sections, suggests/performs archival, generates checkpoints
set -euo pipefail

MEMORY_FILE="${1:-$HOME/.openclaw/workspace/MEMORY.md}"
WORKSPACE="${MEMORY_FILE%/*}"
ARCHIVE_DIR="${WORKSPACE}/memory/archive"
CHECKPOINT_DIR="${WORKSPACE}/memory"
DATE=$(date +%Y-%m-%d)

# Thresholds (inspired by ReMe's 70% trigger)
LINE_THRESHOLD="${2:-200}"
BYTE_THRESHOLD="${3:-8192}"  # ~8KB ≈ ~2K tokens
TOKEN_ESTIMATE_RATIO=4       # ~4 chars per token

usage() {
  echo "Usage: compact-memory.sh [MEMORY_FILE] [LINE_THRESHOLD] [BYTE_THRESHOLD]"
  echo ""
  echo "Commands (via env COMPACT_ACTION):"
  echo "  check    — report size & suggest archival (default)"
  echo "  archive  — actually archive suggested sections"
  echo "  checkpoint — generate a structured checkpoint from today's memory"
  exit 0
}

[[ "${1:-}" == "--help" || "${1:-}" == "-h" ]] && usage

if [[ ! -f "$MEMORY_FILE" ]]; then
  echo "❌ MEMORY.md not found at $MEMORY_FILE"
  exit 1
fi

ACTION="${COMPACT_ACTION:-check}"

# --- Metrics ---
LINE_COUNT=$(wc -l < "$MEMORY_FILE")
BYTE_COUNT=$(wc -c < "$MEMORY_FILE" | tr -d ' ')
EST_TOKENS=$((BYTE_COUNT / TOKEN_ESTIMATE_RATIO))

echo "📊 MEMORY.md Analysis"
echo "   Lines:  ${LINE_COUNT} (threshold: ${LINE_THRESHOLD})"
echo "   Bytes:  ${BYTE_COUNT} (threshold: ${BYTE_THRESHOLD})"
echo "   ~Tokens: ${EST_TOKENS}"
echo ""

OVER_LINES=0
OVER_BYTES=0
[[ $LINE_COUNT -gt $LINE_THRESHOLD ]] && OVER_LINES=1
[[ $BYTE_COUNT -gt $BYTE_THRESHOLD ]] && OVER_BYTES=1

if [[ $OVER_LINES -eq 0 && $OVER_BYTES -eq 0 ]]; then
  echo "✅ Under all thresholds. No compaction needed."
  exit 0
fi

echo "⚠️  Compaction recommended:"
[[ $OVER_LINES -eq 1 ]] && echo "   Lines over by $((LINE_COUNT - LINE_THRESHOLD))"
[[ $OVER_BYTES -eq 1 ]] && echo "   Bytes over by $((BYTE_COUNT - BYTE_THRESHOLD))"
echo ""

# --- Section Analysis ---
echo "📋 Sections by size (largest first):"
echo "─────────────────────────────────────"
awk '
/^## / {
  if (section != "") printf "  %4d lines  %5d bytes — %s\n", NR - start, bytes, section
  section = $0; start = NR; bytes = 0
}
{ bytes += length($0) + 1 }
END {
  if (section != "") printf "  %4d lines  %5d bytes — %s\n", NR - start + 1, bytes, section
}
' "$MEMORY_FILE" | sort -rn | head -20
echo ""

# --- Archive Candidates (reference-only sections safe to move) ---
ARCHIVE_CANDIDATES=("Key People" "Financial Snapshot" "Daily Life" "Upcoming Travel" "Relationship Pattern" "Content Ready to Publish" "Security Alert" "Emails" "Apartment Notes" "Health" "Lessons Learned")

echo "💡 Archive candidates (reference sections → memory/archive/):"
FOUND_ANY=0
for candidate in "${ARCHIVE_CANDIDATES[@]}"; do
  STATS=$(awk -v sec="## $candidate" '
    $0 == sec { start=NR; bytes=0; next }
    start && /^## / { printf "%d %d", NR - start, bytes; start=0 }
    start { bytes += length($0) + 1 }
    END { if (start) printf "%d %d", NR - start + 1, bytes }
  ' "$MEMORY_FILE")
  if [[ -n "$STATS" ]]; then
    LINES=$(echo "$STATS" | awk '{print $1}')
    BYTES=$(echo "$STATS" | awk '{print $2}')
    SLUG=$(echo "$candidate" | tr ' ' '-' | tr '[:upper:]' '[:lower:]')
    echo "  → \"$candidate\" (${LINES} lines, ${BYTES} bytes) → archive/${SLUG}-${DATE}.md"
    FOUND_ANY=1
  fi
done

[[ $FOUND_ANY -eq 0 ]] && echo "  (none of the known candidates found)"
echo ""

# --- Archive Action ---
if [[ "$ACTION" == "archive" ]]; then
  mkdir -p "$ARCHIVE_DIR"
  ARCHIVED=0
  for candidate in "${ARCHIVE_CANDIDATES[@]}"; do
    SLUG=$(echo "$candidate" | tr ' ' '-' | tr '[:upper:]' '[:lower:]')
    CONTENT=$(awk -v sec="## $candidate" '
      $0 == sec { found=1 }
      found && /^## / && $0 != sec { found=0 }
      found { print }
    ' "$MEMORY_FILE")
    if [[ -n "$CONTENT" ]]; then
      DEST="$ARCHIVE_DIR/${SLUG}-${DATE}.md"
      echo "$CONTENT" > "$DEST"
      echo "  ✅ Archived: $candidate → $DEST"
      # Remove from MEMORY.md (use temp file for safety)
      awk -v sec="## $candidate" '
        $0 == sec { skip=1; next }
        skip && /^## / { skip=0 }
        !skip { print }
      ' "$MEMORY_FILE" > "${MEMORY_FILE}.tmp"
      mv "${MEMORY_FILE}.tmp" "$MEMORY_FILE"
      ARCHIVED=$((ARCHIVED + 1))
    fi
  done
  echo ""
  NEW_LINES=$(wc -l < "$MEMORY_FILE")
  NEW_BYTES=$(wc -c < "$MEMORY_FILE" | tr -d ' ')
  echo "📊 After archival: ${NEW_LINES} lines, ${NEW_BYTES} bytes (was ${LINE_COUNT} lines, ${BYTE_COUNT} bytes)"
  echo "   Archived ${ARCHIVED} sections"
fi

# --- Checkpoint Generation ---
if [[ "$ACTION" == "checkpoint" ]]; then
  CHECKPOINT_FILE="$CHECKPOINT_DIR/checkpoint-${DATE}.md"
  TEMPLATE="$WORKSPACE/memory/checkpoint-template.md"
  if [[ -f "$TEMPLATE" ]]; then
    cp "$TEMPLATE" "$CHECKPOINT_FILE"
    sed -i '' "s/YYYY-MM-DD/${DATE}/g" "$CHECKPOINT_FILE" 2>/dev/null || sed -i "s/YYYY-MM-DD/${DATE}/g" "$CHECKPOINT_FILE"
    echo "📝 Checkpoint created: $CHECKPOINT_FILE (from template)"
    echo "   Edit it to fill in current session state."
  else
    echo "❌ Template not found at $TEMPLATE"
    exit 1
  fi
fi

echo ""
echo "🔧 Actions:"
echo "  COMPACT_ACTION=archive $0    # Archive candidate sections"
echo "  COMPACT_ACTION=checkpoint $0 # Generate checkpoint from template"
