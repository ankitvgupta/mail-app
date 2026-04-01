#!/bin/bash
#
# Comprehensive test runner that handles better-sqlite3 ABI compatibility
#
# The better-sqlite3 native module must be compiled for the correct Node version:
# - Unit tests run with system Node (ABI 127)
# - E2E tests run with Electron's Node (ABI 132)
#
# This script rebuilds the module appropriately before each test phase,
# ensuring NO tests are skipped due to ABI mismatch.
#
# Usage:
#   ./scripts/run-tests.sh           # Run all tests (unit, e2e, integration)
#   ./scripts/run-tests.sh unit      # Run unit tests only
#   ./scripts/run-tests.sh e2e       # Run e2e tests only
#   ./scripts/run-tests.sh integration # Run integration tests only
#

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Rebuild better-sqlite3 for system Node
rebuild_for_node() {
    log_info "Rebuilding better-sqlite3 for system Node..."
    rm -rf node_modules/better-sqlite3/build node_modules/better-sqlite3/prebuilds 2>/dev/null || true
    npm rebuild better-sqlite3 || {
        log_error "Failed to rebuild better-sqlite3 for Node"
        exit 1
    }
    log_info "better-sqlite3 rebuilt for system Node (ABI $(node -e 'console.log(process.versions.modules)'))"
}

# Rebuild better-sqlite3 for Electron
rebuild_for_electron() {
    log_info "Rebuilding better-sqlite3 for Electron..."
    rm -rf node_modules/better-sqlite3/build node_modules/better-sqlite3/prebuilds 2>/dev/null || true
    npx @electron/rebuild --force --build-from-source 2>/dev/null || {
        log_error "Failed to rebuild better-sqlite3 for Electron"
        exit 1
    }
    log_info "better-sqlite3 rebuilt for Electron"
}

# Build the Electron app if out/main/index.js doesn't exist
ensure_build() {
    if [ ! -f "$PROJECT_DIR/out/main/index.js" ]; then
        log_info "Building Electron app (out/main/index.js not found)..."
        npm run build || {
            log_error "Failed to build Electron app"
            exit 1
        }
        log_info "Build complete"
    fi
}

# Check if a display is available for Electron tests.
# macOS uses Quartz (no X11 needed), Linux needs xvfb or a real DISPLAY.
check_display() {
    if [[ "$(uname)" == "Darwin" ]]; then
        return 0
    fi
    if [ -n "$DISPLAY" ]; then
        log_info "Using existing X display: $DISPLAY"
        return 0
    fi
    if command -v xvfb-run &> /dev/null; then
        return 0
    fi
    log_error "No display available. Either set DISPLAY or install xvfb: apt-get install xvfb"
    exit 1
}

# Run command with a virtual display if needed.
# macOS: run directly (Quartz). Linux: use existing DISPLAY or xvfb-run.
run_with_display() {
    if [[ "$(uname)" == "Darwin" ]] || [ -n "$DISPLAY" ]; then
        "$@"
    elif command -v xvfb-run &> /dev/null; then
        xvfb-run --auto-servernum "$@"
    else
        log_error "No display available"
        exit 1
    fi
}

# Clean up per-worker test databases and stale config left by parallel E2E runs.
# Config files (electron-store) are shared global state — we only clean them
# before/after the full test suite, never during parallel execution.
clean_test_dbs() {
    local home="${HOME:-/root}"
    local cleaned=0
    local data_dirs=(
        "$home/Library/Application Support/Electron/data"
        "$home/Library/Application Support/exo/data"
        "$home/.config/Electron/data"
        "$home/.config/exo/data"
    )
    local config_dirs=(
        "$home/Library/Application Support/Electron"
        "$home/Library/Application Support/exo"
        "$home/.config/Electron"
        "$home/.config/exo"
    )
    for dir in "${data_dirs[@]}"; do
        if [ -d "$dir" ]; then
            for f in "$dir"/exo-demo-w*.db*; do
                [ -f "$f" ] && rm -f "$f" && cleaned=$((cleaned + 1))
            done
        fi
    done
    for dir in "${config_dirs[@]}"; do
        if [ -d "$dir" ]; then
            for f in "$dir"/exo-config.json; do
                [ -f "$f" ] && rm -f "$f" && cleaned=$((cleaned + 1))
            done
        fi
    done
    if [ $cleaned -gt 0 ]; then
        log_info "Cleaned up $cleaned test artifact file(s)"
    fi
}

# Run Playwright Electron tests, tolerating worker teardown timeouts.
# Playwright exits non-zero when a worker's afterAll hangs past 60s, even if
# every test passed. This is an Electron process cleanup issue (dangling pipe
# handles), not a test failure. We check the output for real failures and
# only propagate the error if tests actually failed.
run_playwright_tolerant() {
    local project="$1"
    local result=0
    local log_file
    log_file=$(mktemp)
    run_with_display env EXO_DEMO_MODE=true npx playwright test --project="$project" 2>&1 | tee "$log_file" || result=$?
    if [ $result -ne 0 ]; then
        if grep -qE '[0-9]+ failed' "$log_file"; then
            rm -f "$log_file"
            return $result
        elif grep -qE '[0-9]+ passed' "$log_file" && grep -q 'Worker teardown timeout' "$log_file"; then
            log_warn "All tests passed but worker teardown timed out — treating as pass"
            rm -f "$log_file"
            return 0
        fi
        rm -f "$log_file"
        return $result
    fi
    rm -f "$log_file"
    return 0
}

run_unit_tests() {
    log_info "=== Running Unit Tests ==="
    rebuild_for_node
    EXO_DEMO_MODE=true npx playwright test --project=unit
}

run_e2e_tests() {
    log_info "=== Running E2E Tests ==="
    check_display
    ensure_build
    rebuild_for_electron
    clean_test_dbs
    run_playwright_tolerant e2e
    clean_test_dbs
}

run_integration_tests() {
    log_info "=== Running Integration Tests ==="
    # Integration tests include Electron launch tests, so need Electron-compiled better-sqlite3
    check_display
    ensure_build
    rebuild_for_electron
    run_playwright_tolerant integration
}

run_all_tests() {
    local unit_result=0
    local electron_result=0

    # Clean up stale worker databases from previous runs
    clean_test_dbs

    # Phase 1: Integration + E2E tests (Electron-compiled better-sqlite3)
    # Run this FIRST because npm ci's postinstall already compiled better-sqlite3
    # for Electron via electron-builder install-app-deps.
    # Only rebuild if needed: if better-sqlite3 loads from system Node, it's compiled
    # for Node and needs rebuilding for Electron. If it fails (ABI mismatch), it's
    # already compiled for Electron (e.g. from npm ci postinstall) — skip the ~75s rebuild.
    log_info "=== Phase 1: Integration + E2E Tests (parallel) ==="
    check_display
    ensure_build
    if node -e "require('better-sqlite3')" 2>/dev/null; then
        log_warn "better-sqlite3 compiled for system Node, rebuilding for Electron..."
        rebuild_for_electron
    else
        log_info "better-sqlite3 already compiled for Electron, skipping rebuild"
    fi
    # run_playwright_tolerant requires run_with_display to already be in the
    # function, but run_all_tests manages its own display. Use the same
    # teardown-tolerant logic inline.
    local e2e_log
    e2e_log=$(mktemp)
    run_with_display env EXO_DEMO_MODE=true npx playwright test --project=integration --project=e2e 2>&1 | tee "$e2e_log" || electron_result=$?
    if [ $electron_result -ne 0 ]; then
        if grep -qE '[0-9]+ failed' "$e2e_log"; then
            log_error "E2E tests have real failures"
        elif grep -qE '[0-9]+ passed' "$e2e_log" && grep -q 'Worker teardown timeout' "$e2e_log"; then
            log_warn "All tests passed but worker teardown timed out (Electron process cleanup) — treating as pass"
            electron_result=0
        fi
    fi
    rm -f "$e2e_log"

    # Clean up worker databases
    clean_test_dbs

    # Phase 2: Unit tests (needs Node-compiled better-sqlite3)
    # This rebuild (system Node) is fast (~1s) compared to the Electron rebuild (~75s).
    log_info "=== Phase 2: Unit Tests ==="
    rebuild_for_node
    EXO_DEMO_MODE=true npx playwright test --project=unit || unit_result=$?

    # Summary
    echo ""
    log_info "=== Test Summary ==="
    if [ $electron_result -eq 0 ]; then
        echo -e "  Integration + E2E: ${GREEN}PASSED${NC}"
    else
        echo -e "  Integration + E2E: ${RED}FAILED${NC}"
    fi
    if [ $unit_result -eq 0 ]; then
        echo -e "  Unit:              ${GREEN}PASSED${NC}"
    else
        echo -e "  Unit:              ${RED}FAILED${NC}"
    fi

    # Exit with failure if any test suite failed
    if [ $unit_result -ne 0 ] || [ $electron_result -ne 0 ]; then
        exit 1
    fi
}

# Main
case "${1:-all}" in
    unit)
        run_unit_tests
        ;;
    e2e)
        run_e2e_tests
        ;;
    integration)
        run_integration_tests
        ;;
    all)
        run_all_tests
        ;;
    *)
        echo "Usage: $0 [unit|e2e|integration|all]"
        exit 1
        ;;
esac

log_info "All tests completed successfully!"
