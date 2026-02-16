#!/bin/bash

# Installation Verification Script
# Tests that the Graphite Context-Optimized Plugin is properly installed

set -e

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Test counters
PASS=0
FAIL=0
WARN=0

echo -e "${BLUE}╔════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  Graphite Context-Optimized Plugin Verifier   ║${NC}"
echo -e "${BLUE}║  Version 2.0.0                                 ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════╝${NC}"
echo ""

# Helper functions
print_test() {
  echo -e "${BLUE}Testing:${NC} $1"
}

print_pass() {
  echo -e "  ${GREEN}✓${NC} $1"
  PASS=$((PASS + 1))
}

print_fail() {
  echo -e "  ${RED}✗${NC} $1"
  [ -n "$2" ] && echo -e "    ${RED}$2${NC}"
  FAIL=$((FAIL + 1))
}

print_warn() {
  echo -e "  ${YELLOW}⚠${NC} $1"
  [ -n "$2" ] && echo -e "    ${YELLOW}$2${NC}"
  WARN=$((WARN + 1))
}

# Test 1: Git repository
print_test "Git repository detection"
if [ -d ".git" ]; then
  print_pass "Git repository found"
else
  print_warn "Not a git repository" "Plugin works best in git repos"
fi
echo ""

# Test 2: Plugin directory
print_test "Plugin directory structure"
if [ -d ".claude/plugins/carbon" ]; then
  print_pass "Plugin directory exists"
else
  print_fail "Plugin directory missing" "Run: ./install.sh --project"
fi
echo ""

# Test 3: Hook file
print_test "SessionStart hook file"
HOOK_PATH=".claude/plugins/carbon/hooks/session-start.sh"
if [ -f "$HOOK_PATH" ]; then
  print_pass "Hook file exists"
  
  # Check permissions
  if [ -x "$HOOK_PATH" ]; then
    print_pass "Hook is executable"
  else
    print_fail "Hook not executable" "Run: chmod +x $HOOK_PATH"
  fi
else
  print_fail "Hook file missing" "Run: ./install.sh --project"
fi
echo ""

# Test 4: Settings file
print_test "Settings configuration"
SETTINGS_PATH=".claude/settings.json"
if [ -f "$SETTINGS_PATH" ]; then
  print_pass "Settings file exists"
  
  # Check for SessionStart hook
  if grep -q "SessionStart" "$SETTINGS_PATH" 2>/dev/null; then
    print_pass "SessionStart hook configured"
  else
    print_fail "SessionStart hook not in settings" "Check settings.json configuration"
  fi
else
  print_fail "Settings file missing" "Run: ./install.sh --project"
fi
echo ""

# Test 5: JSON validity
print_test "JSON file validity"
if command -v jq &> /dev/null; then
  # Check plugin.json
  if [ -f ".claude/plugins/carbon/plugin.json" ]; then
    if jq empty .claude/plugins/carbon/plugin.json 2>/dev/null; then
      print_pass "plugin.json is valid"
    else
      print_fail "plugin.json has invalid syntax"
    fi
  fi
  
  # Check settings.json
  if [ -f "$SETTINGS_PATH" ]; then
    if jq empty "$SETTINGS_PATH" 2>/dev/null; then
      print_pass "settings.json is valid"
    else
      print_fail "settings.json has invalid syntax"
    fi
  fi
else
  print_warn "jq not installed" "Cannot validate JSON syntax"
fi
echo ""

# Test 6: Hook execution
print_test "Hook execution test"
if [ -f "$HOOK_PATH" ] && [ -x "$HOOK_PATH" ]; then
  export CLAUDE_PROJECT_DIR="$PWD"
  
  if HOOK_OUTPUT=$(bash "$HOOK_PATH" 2>&1); then
    print_pass "Hook executes successfully"
    
    # Test JSON output
    if command -v jq &> /dev/null; then
      if echo "$HOOK_OUTPUT" | jq empty 2>/dev/null; then
        print_pass "Hook output is valid JSON"
        
        # Check structure
        if echo "$HOOK_OUTPUT" | jq -e '.hookSpecificOutput.hookEventName == "SessionStart"' &> /dev/null; then
          print_pass "Hook output structure correct"
        else
          print_fail "Hook output structure incorrect"
        fi
        
        # Check context
        if echo "$HOOK_OUTPUT" | jq -e '.hookSpecificOutput.additionalContext' &> /dev/null; then
          CONTEXT_LEN=$(echo "$HOOK_OUTPUT" | jq -r '.hookSpecificOutput.additionalContext' | wc -c)
          print_pass "additionalContext present ($CONTEXT_LEN chars)"
        else
          print_fail "additionalContext missing"
        fi
      else
        print_fail "Hook output is not valid JSON"
      fi
    fi
  else
    print_fail "Hook execution failed" "Test manually: bash $HOOK_PATH"
  fi
else
  print_fail "Cannot test hook" "File missing or not executable"
fi
echo ""

# Test 7: Dependencies
print_test "Dependency check"

if command -v git &> /dev/null; then
  GIT_VERSION=$(git --version | cut -d' ' -f3)
  print_pass "git installed ($GIT_VERSION)"
else
  print_fail "git not found" "Required dependency"
fi

if command -v gt &> /dev/null; then
  GT_VERSION=$(gt --version 2>&1 | head -1 || echo "unknown")
  print_pass "Graphite CLI installed ($GT_VERSION)"
else
  print_warn "Graphite CLI not found" "Install: npm install -g @withgraphite/graphite-cli"
fi

if command -v jq &> /dev/null; then
  JQ_VERSION=$(jq --version 2>&1)
  print_pass "jq installed ($JQ_VERSION)"
else
  print_warn "jq not found" "Recommended for JSON processing"
fi

if command -v claude &> /dev/null; then
  print_pass "Claude Code CLI found"
else
  print_warn "Claude Code CLI not in PATH"
fi
echo ""

# Test 8: Agent template
print_test "Custom agent template"
AGENT_TEMPLATE="./agents/graphite-ops-template.md"
if [ -f "$AGENT_TEMPLATE" ]; then
  print_pass "Agent template available"
  echo -e "    ${BLUE}Create agent with: /agents create${NC}"
else
  print_warn "Agent template not found" "Optional feature - not required"
fi
echo ""

# Summary
echo -e "${BLUE}════════════════════════════════════════════════${NC}"
echo -e "${BLUE}Summary:${NC}"
echo -e "  ${GREEN}Passed:${NC}  $PASS"
echo -e "  ${YELLOW}Warnings:${NC} $WARN"
echo -e "  ${RED}Failed:${NC}  $FAIL"
echo -e "${BLUE}════════════════════════════════════════════════${NC}"
echo ""

# Final verdict
if [ $FAIL -eq 0 ]; then
  echo -e "${GREEN}✓ Plugin is properly installed and ready to use!${NC}"
  echo ""
  echo -e "${BLUE}Next steps:${NC}"
  echo "  1. Start Claude Code: claude --debug hooks"
  echo "  2. Verify hook fires: Check for [SessionStart] messages"
  echo "  3. Test delegation: \"Check my Graphite stack\""
  echo "  4. (Optional) Create custom agent: /agents create"
  echo ""
  echo -e "${GREEN}The plugin will automatically optimize git/Graphite operations!${NC}"
  exit 0
else
  echo -e "${RED}✗ Installation issues detected${NC}"
  echo ""
  echo "Fix the failed tests above, then run this script again."
  echo ""
  echo "For help, see:"
  echo "  - docs/QUICKSTART.md"
  echo "  - docs/TROUBLESHOOTING.md"
  echo "  - https://github.com/your-username/carbon/issues"
  exit 1
fi
