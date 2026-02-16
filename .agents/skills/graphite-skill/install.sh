#!/bin/bash

# Installation script for Graphite Context-Optimized Plugin
# Version: 2.0.0

set -e

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo -e "${BLUE}╔════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  Graphite Context-Optimized Plugin Installer  ║${NC}"
echo -e "${BLUE}║  Version 2.0.0                                 ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════╝${NC}"
echo ""

# Parse arguments
INSTALL_MODE=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --global)
      INSTALL_MODE="global"
      shift
      ;;
    --project)
      INSTALL_MODE="project"
      shift
      ;;
    --help)
      echo "Usage: $0 [--global | --project]"
      echo ""
      echo "Options:"
      echo "  --global   Install globally for all your projects"
      echo "  --project  Install in current project (recommended for teams)"
      echo "  --help     Show this help message"
      echo ""
      echo "If no option is specified, you will be prompted to choose."
      exit 0
      ;;
    *)
      echo -e "${RED}Unknown option: $1${NC}"
      echo "Use --help for usage information"
      exit 1
      ;;
  esac
done

# Prompt for installation mode if not specified
if [ -z "$INSTALL_MODE" ]; then
  echo "Choose installation mode:"
  echo "  1) Project (recommended for teams - installs in current directory)"
  echo "  2) Global (installs for all your projects)"
  echo ""
  read -p "Enter choice [1-2]: " choice
  
  case $choice in
    1)
      INSTALL_MODE="project"
      ;;
    2)
      INSTALL_MODE="global"
      ;;
    *)
      echo -e "${RED}Invalid choice. Exiting.${NC}"
      exit 1
      ;;
  esac
fi

echo ""
echo -e "${GREEN}Installation mode: $INSTALL_MODE${NC}"
echo ""

# Set installation directory
if [ "$INSTALL_MODE" = "global" ]; then
  INSTALL_DIR="$HOME/.claude/plugins/carbon"
  SETTINGS_FILE="$HOME/.claude/settings.json"
else
  INSTALL_DIR="$PWD/.claude/plugins/carbon"
  SETTINGS_FILE="$PWD/.claude/settings.json"
fi

# Check if git repository (for project mode)
if [ "$INSTALL_MODE" = "project" ] && [ ! -d ".git" ]; then
  echo -e "${YELLOW}⚠️  Warning: Not a git repository${NC}"
  echo "This plugin works best in git repositories."
  echo ""
  read -p "Continue anyway? [y/N]: " continue
  if [[ ! $continue =~ ^[Yy]$ ]]; then
    echo "Installation cancelled."
    exit 0
  fi
fi

# Create installation directory
echo "Creating installation directory..."
mkdir -p "$INSTALL_DIR/hooks"
mkdir -p "$(dirname "$SETTINGS_FILE")"

# Copy files
echo "Copying plugin files..."
cp "$SCRIPT_DIR/plugin.json" "$INSTALL_DIR/"
cp "$SCRIPT_DIR/settings.json" "$INSTALL_DIR/"
cp "$SCRIPT_DIR/hooks/session-start.sh" "$INSTALL_DIR/hooks/"

# Make hook executable
chmod +x "$INSTALL_DIR/hooks/session-start.sh"

# Copy agent template if project mode
if [ "$INSTALL_MODE" = "project" ]; then
  if [ -f "$SCRIPT_DIR/agents/graphite-ops-template.md" ]; then
    mkdir -p "$PWD/.claude/agents"
    cp "$SCRIPT_DIR/agents/graphite-ops-template.md" "$PWD/.claude/agents/"
    echo "Copied agent template to .claude/agents/"
  fi
fi

# Update settings.json
echo "Configuring hooks..."

# Create settings.json if it doesn't exist
if [ ! -f "$SETTINGS_FILE" ]; then
  echo '{"hooks":{}}' > "$SETTINGS_FILE"
fi

# Add hook configuration
HOOK_CONFIG=$(cat "$INSTALL_DIR/settings.json")

# Use jq to merge if available, otherwise append
if command -v jq &> /dev/null; then
  # Merge using jq
  TMP_FILE=$(mktemp)
  jq -s '.[0] * .[1]' "$SETTINGS_FILE" "$INSTALL_DIR/settings.json" > "$TMP_FILE"
  mv "$TMP_FILE" "$SETTINGS_FILE"
else
  echo -e "${YELLOW}⚠️  jq not found - manual settings merge required${NC}"
  echo "Add the following to $SETTINGS_FILE:"
  echo ""
  cat "$INSTALL_DIR/settings.json"
  echo ""
fi

# Installation complete
echo ""
echo -e "${GREEN}✓ Installation complete!${NC}"
echo ""

# Show next steps
echo -e "${BLUE}Next Steps:${NC}"
echo ""

if [ "$INSTALL_MODE" = "project" ]; then
  echo "1. Commit the plugin configuration to git:"
  echo -e "   ${YELLOW}git add .claude/${NC}"
  echo -e "   ${YELLOW}git commit -m 'Add Graphite context-optimization plugin'${NC}"
  echo ""
  echo "2. (Optional) Create custom agent:"
  echo -e "   ${YELLOW}claude${NC}"
  echo -e "   ${YELLOW}/agents create${NC}"
  echo "     Name: graphite-ops"
  echo "     Color: cyan"
  echo "     Prompt: Load from ./agents/graphite-ops-template.md"
  echo ""
  echo "3. Test the installation:"
  echo -e "   ${YELLOW}./test/verify-installation.sh${NC}"
  echo ""
  echo "4. Start using Claude Code:"
  echo -e "   ${YELLOW}claude${NC}"
  echo -e "   ${YELLOW}> \"Check my Graphite stack\"${NC}"
else
  echo "1. Test the installation:"
  echo -e "   ${YELLOW}cd your-git-project${NC}"
  echo -e "   ${YELLOW}claude --debug hooks${NC}"
  echo ""
  echo "2. Start using Claude Code:"
  echo -e "   ${YELLOW}claude${NC}"
  echo -e "   ${YELLOW}> \"Check my Graphite stack\"${NC}"
fi

echo ""
echo -e "${GREEN}The plugin will automatically activate in git repositories!${NC}"
echo ""

# Check for dependencies
echo -e "${BLUE}Dependency Check:${NC}"
echo ""

if command -v git &> /dev/null; then
  echo -e "${GREEN}✓${NC} git installed"
else
  echo -e "${RED}✗${NC} git not found (required)"
fi

if command -v gt &> /dev/null; then
  echo -e "${GREEN}✓${NC} Graphite CLI installed"
else
  echo -e "${YELLOW}⚠${NC} Graphite CLI not found (optional)"
  echo "  Install with: npm install -g @withgraphite/graphite-cli"
fi

if command -v jq &> /dev/null; then
  echo -e "${GREEN}✓${NC} jq installed"
else
  echo -e "${YELLOW}⚠${NC} jq not found (recommended)"
  echo "  The hook uses jq for JSON processing"
  echo "  Install with: brew install jq (macOS) or apt install jq (Linux)"
fi

echo ""
echo -e "${BLUE}Documentation:${NC}"
echo "  docs/QUICKSTART.md - Get started in 5 minutes"
echo "  docs/USER-GUIDE.md - Complete usage guide"
echo "  docs/CUSTOM-AGENTS.md - Optional custom agent setup"
echo ""
echo -e "${GREEN}Installation successful! Happy coding! 🚀${NC}"
