#!/usr/bin/env bash
#
# install-skills.sh — Install recommended third-party skill packs for joelclaw.
#
# These skills are maintained by their original authors. This script installs
# them from their canonical repos so credit goes to the right people.
#
# Usage:
#   ./install-skills.sh              # Install all packs
#   ./install-skills.sh inngest      # Install just the inngest pack
#   ./install-skills.sh --list       # List available packs
#   ./install-skills.sh --dry-run    # Show what would be installed
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="$SCRIPT_DIR/skillpacks.json"

if [ ! -f "$MANIFEST" ]; then
  echo "Error: skillpacks.json not found at $MANIFEST"
  exit 1
fi

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
DIM='\033[0;90m'
BOLD='\033[1m'
NC='\033[0m'

# Parse args
DRY_RUN=false
LIST_ONLY=false
PACKS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --list|-l) LIST_ONLY=true; shift ;;
    --help|-h)
      echo "Usage: ./install-skills.sh [options] [pack-names...]"
      echo ""
      echo "Options:"
      echo "  --list, -l    List available skill packs"
      echo "  --dry-run     Show what would be installed without installing"
      echo "  --help, -h    Show this help"
      echo ""
      echo "Examples:"
      echo "  ./install-skills.sh              # Install all packs"
      echo "  ./install-skills.sh inngest      # Install just inngest skills"
      echo "  ./install-skills.sh axiom marketing  # Install multiple packs"
      exit 0
      ;;
    *) PACKS+=("$1"); shift ;;
  esac
done

# Read manifest with node (available everywhere joelclaw runs)
read_manifest() {
  node -e "
    const fs = require('fs');
    const data = JSON.parse(fs.readFileSync('$MANIFEST', 'utf8'));
    const packs = data.packs;
    const filter = process.argv.slice(1);
    const selected = filter.length > 0
      ? packs.filter(p => filter.includes(p.name))
      : packs;
    console.log(JSON.stringify(selected));
  " "${PACKS[@]+"${PACKS[@]}"}"
}

list_packs() {
  echo -e "${BOLD}Recommended Skill Packs${NC}"
  echo -e "${DIM}Install from canonical sources — credit goes to the original authors.${NC}"
  echo ""

  node -e "
    const fs = require('fs');
    const data = JSON.parse(fs.readFileSync('$MANIFEST', 'utf8'));
    for (const pack of data.packs) {
      console.log('  \x1b[1m' + pack.name + '\x1b[0m (' + pack.skills.length + ' skills)');
      console.log('  \x1b[90m' + pack.repo + '\x1b[0m');
      console.log('  ' + pack.description);
      console.log('  \x1b[90mSkills: ' + pack.skills.join(', ') + '\x1b[0m');
      console.log('');
    }
    const total = data.packs.reduce((n, p) => n + p.skills.length, 0);
    console.log('  \x1b[90m' + data.packs.length + ' packs, ' + total + ' skills total\x1b[0m');
  "
}

install_packs() {
  local selected
  selected=$(read_manifest)

  local pack_count
  pack_count=$(echo "$selected" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d.length)")

  if [ "$pack_count" = "0" ]; then
    echo -e "${RED}No matching packs found.${NC} Use --list to see available packs."
    exit 1
  fi

  echo -e "${BOLD}Installing skill packs${NC}"
  echo ""

  # Build install commands as a temp script to avoid stdin conflicts
  local tmpscript
  tmpscript=$(mktemp)

  echo "$selected" | node -e "
    const packs = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'));
    for (const pack of packs) {
      console.log([pack.name, pack.repo, pack.url, pack.skills.length].join('|'));
    }
  " > "$tmpscript"

  while IFS='|' read -r name repo url skill_count; do
    echo -e "  ${BLUE}▸${NC} ${BOLD}$name${NC} ${DIM}($skill_count skills from $repo)${NC}"
    echo -e "    ${DIM}$url${NC}"

    if [ "$DRY_RUN" = true ]; then
      echo -e "    ${DIM}npx skills add $repo --yes --all${NC}"
    else
      if npx skills add "$repo" --yes --all </dev/null 2>&1 | tail -1; then
        echo -e "    ${GREEN}✓ Installed${NC}"
      else
        echo -e "    ${RED}✗ Failed — try manually: npx skills add $repo --yes --all${NC}"
      fi
    fi
    echo ""
  done < "$tmpscript"

  rm -f "$tmpscript"

  if [ "$DRY_RUN" = true ]; then
    echo -e "${DIM}Dry run — nothing was installed.${NC}"
  else
    echo -e "${GREEN}Done.${NC} Skills installed from their canonical sources with proper attribution."
  fi
}

if [ "$LIST_ONLY" = true ]; then
  list_packs
else
  install_packs
fi
