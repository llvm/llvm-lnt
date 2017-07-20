#!/bin/bash
# This script wraps a call to lnt runtest with a local server
# instance.  It is intended for testing full runtest invocations
# that need a real server instance to work. Starts a server at
# `http://localhost:9089`.
# ./server_wrapper <location of server files> <port> <command>
# Example:
# ./server_wrapper /tmp 9089 lnt runtest nt --submit "http://localhost:9089/db_default/submitRun" --cc /bin/clang --sandbox /tmp/sandbox

# First launch the server.

PROGRAM="$(basename $0)"

usage() {
	echo "usage: $PROGRAM <location of server files> <runtest type> <submit-through-url> <portnr> [arguments for lnt runtest]"
	echo "e.g:   $PROGRAM /tmp/ nt yes --cc /bin/clang --sandbox /tmp/sandbox"
}

error() {
	echo "error: $PROGRAM: $*" >&2
	usage >&2
	exit 1
}

main() {
	[ $# -lt 2 ] &&
		error "not enough arguments"

	local serverinstance=$1
	local portnr=$2
	shift 2

	lnt runserver $serverinstance --hostname localhost --port $portnr >& $serverinstance/server_wrapper_runserver.log &
	local pid=$!
	sleep 2 # Give the server some time to start.

	# Execute command.
	eval "$@"
	local rc=$?

	kill -15 $pid
	local kill_rc=$?
	[ $kill_rc -ne 0 ] &&
	    error "wha happen??  $kill_rc"
	
	wait $pid
	exit $rc
}

main "$@"
