#!/bin/sh

if [ ! -e ./setup.py ]; then
    echo 1>&2 "Should start this script from the toplevel lnt directory"
    exit 1
fi
pycodestyle --exclude='lnt/external/stats/,docs/conf.py,tests/' .
