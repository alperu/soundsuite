#!/bin/bash

###############################################################################
# Sound Suite - Restart Script
# 
# This script orchestrates a complete restart of all Sound Suite services:
# 1. Calls stop script to gracefully shutdown all services
# 2. Waits for clean shutdown confirmation
# 3. Calls start script to bring services back up
# 4. Verifies all services restarted successfully
# 5. Provides clear status output throughout the process
# 
# Requirements: All
###############################################################################

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
PID_DIR="$PROJECT_ROOT/.pids"

# Function to print colored messages
print_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

print_step() {
    echo -e "${CYAN}[STEP]${NC} $1"
}

# Function to check if a process is running
is_running() {
    local pid=$1
    if [ -z "$pid" ]; then
        return 1
    fi
    kill -0 "$pid" 2>/dev/null
    return $?
}

# Function to verify all services are stopped
verify_stopped() {
    print_info "Verifying all services are stopped..."
    
    if [ ! -d "$PID_DIR" ]; then
        print_success "No PID directory found - all services stopped"
        return 0
    fi
    
    local still_running=false
    local services=("dashboard" "mcp-server" "job-queue" "file-watcher")
    
    for service in "${services[@]}"; do
        local pid_file="$PID_DIR/$service.pid"
        if [ -f "$pid_file" ]; then
            local pid=$(cat "$pid_file")
            if is_running "$pid"; then
                print_error "$service is still running (PID: $pid)"
                still_running=true
            fi
        fi
    done
    
    if [ "$still_running" = true ]; then
        return 1
    fi
    
    print_success "All services confirmed stopped"
    return 0
}

# Function to verify all services are running
verify_running() {
    print_info "Verifying all services are running..."
    
    if [ ! -d "$PID_DIR" ]; then
        print_error "No PID directory found - services may not have started"
        return 1
    fi
    
    # Check dashboard (main service)
    if [ -f "$PID_DIR/dashboard.pid" ]; then
        local pid=$(cat "$PID_DIR/dashboard.pid")
        if is_running "$pid"; then
            print_success "Dashboard is running (PID: $pid)"
        else
            print_error "Dashboard is not running"
            return 1
        fi
    else
        print_error "Dashboard PID file not found"
        return 1
    fi
    
    # Note: Other services (MCP, job queue, file watcher) are integrated with dashboard
    # so if dashboard is running, they should be running too
    
    print_success "All services confirmed running"
    return 0
}

# Parse command line arguments
MODE="dev"
if [ "$1" = "production" ] || [ "$1" = "prod" ]; then
    MODE="production"
fi

# Display restart banner
echo ""
print_success "═══════════════════════════════════════════════════════════"
print_success "  Sound Suite - Restart Services"
print_success "═══════════════════════════════════════════════════════════"
echo ""
print_info "Mode: $MODE"
print_info "This will stop all services and start them again"
echo ""

###############################################################################
# Step 1: Stop all services
###############################################################################

print_step "Step 1/4: Stopping all services..."
echo ""

# Call stop script
if [ -f "$SCRIPT_DIR/stop.sh" ]; then
    if bash "$SCRIPT_DIR/stop.sh"; then
        print_success "Stop script completed successfully"
    else
        STOP_EXIT_CODE=$?
        print_error "Stop script failed with exit code: $STOP_EXIT_CODE"
        print_warning "Attempting to continue with restart..."
    fi
else
    print_error "Stop script not found at: $SCRIPT_DIR/stop.sh"
    print_info "Cannot proceed with restart"
    exit 1
fi

echo ""

###############################################################################
# Step 2: Wait for clean shutdown
###############################################################################

print_step "Step 2/4: Waiting for clean shutdown..."
echo ""

# Wait a moment for processes to fully terminate
sleep 2

# Verify all services are stopped
if verify_stopped; then
    print_success "Clean shutdown confirmed"
else
    print_error "Some services are still running"
    print_warning "Waiting additional 5 seconds..."
    sleep 5
    
    if verify_stopped; then
        print_success "Clean shutdown confirmed after additional wait"
    else
        print_error "Failed to achieve clean shutdown"
        print_info "You may need to manually kill processes:"
        echo "  ps aux | grep -E 'node|next'"
        echo "  pkill -9 -f 'next-server'"
        exit 1
    fi
fi

echo ""

###############################################################################
# Step 3: Start all services
###############################################################################

print_step "Step 3/4: Starting all services..."
echo ""

# Call start script
if [ -f "$SCRIPT_DIR/start.sh" ]; then
    if bash "$SCRIPT_DIR/start.sh" "$MODE"; then
        print_success "Start script completed successfully"
    else
        START_EXIT_CODE=$?
        print_error "Start script failed with exit code: $START_EXIT_CODE"
        print_info "Check logs at: $PROJECT_ROOT/logs/dashboard.log"
        exit 1
    fi
else
    print_error "Start script not found at: $SCRIPT_DIR/start.sh"
    exit 1
fi

echo ""

###############################################################################
# Step 4: Verify all services restarted successfully
###############################################################################

print_step "Step 4/4: Verifying services restarted successfully..."
echo ""

# Wait a moment for services to initialize
sleep 3

# Verify all services are running
if verify_running; then
    print_success "All services verified running"
else
    print_error "Service verification failed"
    print_info "Check logs at: $PROJECT_ROOT/logs/dashboard.log"
    print_info "Run health check: ./scripts/health-check.sh"
    exit 1
fi

echo ""

###############################################################################
# Final Status
###############################################################################

print_success "═══════════════════════════════════════════════════════════"
print_success "  Restart Complete!"
print_success "═══════════════════════════════════════════════════════════"
echo ""
print_info "Service Status:"
if [ -f "$PID_DIR/dashboard.pid" ]; then
    DASHBOARD_PID=$(cat "$PID_DIR/dashboard.pid")
    echo "  • Dashboard:     Running (PID: $DASHBOARD_PID)"
else
    echo "  • Dashboard:     Unknown"
fi
echo "  • File Watcher:  Integrated with dashboard"
echo "  • Job Queue:     Integrated with dashboard"
echo "  • MCP Server:    Integrated with dashboard"
echo ""
print_info "Access Points:"
echo "  • Dashboard:     http://localhost:3000"
echo "  • MCP Server:    http://localhost:${MCP_PORT:-3001}"
echo ""
print_info "Next Steps:"
echo "  • Run health check: ./scripts/health-check.sh"
echo "  • View logs:        tail -f $PROJECT_ROOT/logs/dashboard.log"
echo "  • Stop services:    ./scripts/stop.sh"
echo ""

exit 0
