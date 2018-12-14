"""
Smash a LNT instance with random submissions.

This should only be used for (load) testing.  It will add a bunch
of bad data to your instance, so don't use it on a production instance.
"""
## Just to make sure there are no syntax errors in this.  This does not
## actually run a blast.
# RUN: python %{src_root}/tests/utils/blast.py
import time
import subprocess
import os
import lnt.testing
import tempfile
import random
import sys

TESTS = ["about", "after", "again", "air", "all", "along", "also", "an", "and", "another", "any", "are", "around", "as",
         "at", "away", "back", "be", "because", "been", "before", "below", "between", "both", "but", "by", "came",
         "can", "come", "could", "day", "did", "different", "do", "does", "don't", "down", "each", "end", "even",
         "every", "few", "find", "first", "for", "found", "from", "get", "give", "go", "good", "great", "had", "has",
         "have", "he", "help", "her", "here", "him", "his", "home", "house", "how", "I", "if", "in", "into", "is", "it",
         "its", "just", "know", "large", "last", "left", "like", "line", "little", "long", "look", "made", "make",
         "man", "many", "may", "me", "men", "might", "more", "most", "Mr.", "must", "my", "name", "never", "new",
         "next", "no", "not", "now", "number", "of", "off", "old", "on", "one", "only", "or", "other", "our", "out",
         "over", "own", "part", "people", "place", "put", "read", "right", "said", "same", "saw", "say", "see", "she",
         "should", "show", "small", "so", "some", "something", "sound", "still", "such", "take", "tell", "than", "that",
         "the", "them", "then", "there", "these", "they", "thing", "think", "this", "those", "thought", "three",
         "through", "time", "to", "together", "too", "two", "under", "up", "us", "use", "very", "want", "water", "way",
         "we", "well", "went", "were", "what", "when", "where", "which", "while", "who", "why", "will", "with", "word",
         "work", "world", "would", "write", "year", "you", "your", "was"]


def external_submission(url, fname):
    """Use a LNT subprocess to submit our results."""
    assert os.path.exists(fname)
    cmd = "lnt submit --verbose {url} {file}".format(
        url=url, file=fname)
    print "Calling " + cmd
    subprocess.check_call(cmd, shell=True)


def rand_sample():
    """Make a random sized list of random samples."""
    r = random.randint(1, 20)
    samples = []
    for i in xrange(r):
        samples.append(random.random() * 100)
    return samples


run_info = {'tag': 'nts'}

start_time = "2015-11-11 22:04:09"
end_time = "2015-11-11 23:04:09"
MACH = "LNTLoadTest-Blast"
DEFAULT_MACHINE_INFO = {'hardware': '', 'os': 'darwin'}
# Setup our run_order since it is an info_key.
# run_info_copy = dict(run_info)
tstamp = int(time.time())
run_info['run_order'] = tstamp

if len(sys.argv) < 3:
    print "Usage: python blast.py <num_submissions> <sleep_between> [optional url]"
    sys.exit(0)

for i in xrange(int(sys.argv[1])):
    machine = lnt.testing.Machine(MACH, DEFAULT_MACHINE_INFO)
    run = lnt.testing.Run(start_time, end_time, run_info)
    report = lnt.testing.Report(machine=machine, run=run, tests=[])

    for t in TESTS:
        full_test_name = "nts.{}.compile".format(t)
        tests = lnt.testing.TestSamples(full_test_name, rand_sample())
        report.tests.append(tests)

    f_os, fname = tempfile.mkstemp(text=True, suffix='.json', prefix='lnt-stats-')
    f = os.fdopen(f_os, "w")
    print >> f, report.render()
    f.close()
    local = "http://localhost:8000/db_default/submitRun"
    if len(sys.argv) == 4:
        target = sys.argv[3]
    else:
        target = local
    external_submission(target, fname)
    time.sleep(int(sys.argv[2]))
