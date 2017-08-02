"""
Post submission hook to write the current state of the profiles directory. This
gets fed into the profile/admin page.
"""
import datetime
import glob
import json
import os
import subprocess
import time


def update_profile_stats(ts, run_id):
    config = ts.v4db.config

    history_path = os.path.join(config.profileDir, '_profile-history.json')
    age_path = os.path.join(config.profileDir, '_profile-age.json')
    profile_path = config.profileDir

    if not os.path.exists(profile_path):
        return

    try:
        history = json.loads(open(history_path).read())
    except:
        history = []
    age = []

    dt = time.time()
    blocks = subprocess.check_output("du -s -k %s" % profile_path,
                                     shell=True).split('\t')[0]
    kb = float(blocks)  # 1024 byte blocks.

    history.append((dt, kb))

    for f in glob.glob('%s/*.lntprof' % profile_path):
        mtime = os.stat(f).st_mtime
        sz = os.stat(f).st_size / 1000
        age.append([mtime, sz])

    open(history_path, 'w').write(json.dumps(history))
    open(age_path, 'w').write(json.dumps(age))

post_submission_hook = update_profile_stats
