from flask import render_template, current_app
import os, json
from lnt.server.ui.decorators import v4_route, frontend
from lnt.server.ui.globals import v4_url_for

@frontend.route('/profile/admin')
def profile_admin():
    profileDir = current_app.old_config.profileDir

    history_path = os.path.join(profileDir, '_profile-history.json')
    age_path = os.path.join(profileDir, '_profile-age.json')

    try:
        history = json.loads(open(history_path).read())
    except:
        history = []
    try:
        age = json.loads(open(age_path).read())
    except:
        age = []

    # Convert from UNIX timestamps to Javascript timestamps.
    history = [[x * 1000, y] for x,y in history]
    age = [[x * 1000, y] for x,y in age]

    # Calculate a histogram bucket size that shows ~20 bars on the screen
    num_buckets = 20
    
    range = max(a[0] for a in age) - min(a[0] for a in age)
    bucket_size = float(range) / float(num_buckets)
    
    # Construct the histogram.
    hist = {}
    for x,y in age:
        z = int(float(x) / bucket_size)
        hist.setdefault(z, 0)
        hist[z] += y
    age = [[k * bucket_size, hist[k]] for k in sorted(hist.keys())]

    return render_template("profile_admin.html",
                           history=history, age=age, bucket_size=bucket_size)
