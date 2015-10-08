#!/bin/bash
# This script wraps a call to lnt runtest with a local server
# instance.  It is intended for testing full runtest invocations
# that need a real server instnace to work.
# ./runtest_server_wrapper <location of server files> <runtest type> <submit-through-url> <portnr> [arguments for lnt runtest]
# ./runtest_server_wrapper /tmp/ nt --cc /bin/clang --sandbox /tmp/sandbox

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
	local portnr=$4
	lnt runserver $serverinstance --hostname localhost --port $portnr &
	local pid=$!
	local type=$2
	local submit_through_url=$3
	shift 4
	case $submit_through_url in
	    [yY][eE][sS]|[yY])
	        submit_pointer=http://localhost:$portnr/db_default/submitRun
		;;
	    *)
	        submit_pointer=$serverinstance
		;;
	esac
	lnt runtest $type --submit $submit_pointer $@
	local rc=$?

	kill -15 $pid
	local kill_rc=$?
	[ $kill_rc -ne 0 ] &&
	    error "wha happen??  $kill_rc"
	
	wait $pid
	exit $rc
}

main "$@"
