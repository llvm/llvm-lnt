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

	local server_instance=$1
	local port_number=$2
	shift 2

	lnt runserver ${server_instance} --hostname localhost --port ${port_number} >& ${server_instance}/server_wrapper_runserver.log &
	local pid=$!

	# Poll the server until it is up and running
	while ! curl http://localhost:${port_number}/ping -m1 -o/dev/null -s ; do
        # Maybe server is totally dead.
        kill -0 ${pid} 2> /dev/null || { echo "Server exit detected"; cat ${server_instance}/server_wrapper_runserver.log; break; }
        # If not sleep and keep trying.
        sleep 0.1
    done

	# Execute command.
	eval "$@"
	local rc=$?

	kill -15 ${pid}
	local kill_rc=$?
	[ ${kill_rc} -ne 0 ] &&
	    error "wha happen??  ${kill_rc}"
	
	wait ${pid}
	exit ${rc}
}

main "$@"
