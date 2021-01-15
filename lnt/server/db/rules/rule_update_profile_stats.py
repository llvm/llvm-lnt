"""
Post submission hook to write the current state of the profiles directory. This
gets fed into the profile/admin page.
"""
import glob
import json
import os
import subprocess
import time


def update_profile_stats(session, ts, run_id):
    config = ts.v4db.config

    history_path = os.path.join(config.profileDir, '_profile-history.json')
    age_path = os.path.join(config.profileDir, '_profile-age.json')
    profile_path = config.profileDir

    if not os.path.exists(profile_path):
        return

    try:
        with open(history_path) as f:
            history = json.loads(f.read())
    except Exception:
        history = []
    age = []

    dt = time.time()
    blocks = subprocess.check_output("du -s -k %s" % profile_path,
                                     shell=True,
                                     universal_newlines=True).split('\t')[0]
    kb = float(blocks)  # 1024 byte blocks.

    history.append((dt, kb))

    for f in glob.glob('%s/*.lntprof' % profile_path):
        mtime = os.stat(f).st_mtime
        sz = os.stat(f).st_size // 1000
        age.append([mtime, sz])

    with open(history_path, 'w') as history_f:
        history_f.write(json.dumps(history))
    with open(age_path, 'w') as age_f:
        age_f.write(json.dumps(age))


post_submission_hook = update_profile_stats
