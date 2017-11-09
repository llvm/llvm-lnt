import datetime
from flask import g
from flask import abort
from flask import render_template
from flask import request
from flask import make_response
from flask import flash
from flask import redirect
from flask import current_app
from sqlalchemy.orm.exc import NoResultFound
import flask
import json
import sys
import os

from flask import render_template, current_app
import os
import json
from lnt.server.ui.decorators import v4_route, frontend
from lnt.server.ui.globals import v4_url_for
from lnt.server.ui.views import ts_data


@frontend.route('/profile/admin')
def profile_admin():
    profileDir = current_app.old_config.profileDir

    history_path = os.path.join(profileDir, '_profile-history.json')
    age_path = os.path.join(profileDir, '_profile-age.json')

    try:
        history = json.loads(open(history_path).read())
    except Exception:
        history = []
    try:
        age = json.loads(open(age_path).read())
    except Exception:
        age = []

    # Convert from UNIX timestamps to Javascript timestamps.
    history = [[x * 1000, y] for x, y in history]
    age = [[x * 1000, y] for x, y in age]

    # Calculate a histogram bucket size that shows ~20 bars on the screen
    num_buckets = 20

    if len(age) > 0:
        range = max(a[0] for a in age) - min(a[0] for a in age)
    else:
        range = 0
    bucket_size = float(range) / float(num_buckets)

    # Construct the histogram.
    hist = {}
    for x, y in age:
        z = int(float(x) / bucket_size)
        hist.setdefault(z, 0)
        hist[z] += y
    age = [[k * bucket_size, hist[k]] for k in sorted(hist.keys())]

    return render_template("profile_admin.html",
                           history=history, age=age, bucket_size=bucket_size)


@v4_route("/profile/ajax/getFunctions")
def v4_profile_ajax_getFunctions():
    session = request.session
    ts = request.get_testsuite()
    runid = request.args.get('runid')
    testid = request.args.get('testid')

    profileDir = current_app.old_config.profileDir

    idx = 0
    tlc = {}
    sample = session.query(ts.Sample) \
                    .filter(ts.Sample.run_id == runid) \
                    .filter(ts.Sample.test_id == testid).first()
    if sample and sample.profile:
        p = sample.profile.load(profileDir)
        return json.dumps([[n, f] for n, f in p.getFunctions().items()])
    else:
        abort(404)


@v4_route("/profile/ajax/getTopLevelCounters")
def v4_profile_ajax_getTopLevelCounters():
    session = request.session
    ts = request.get_testsuite()
    runids = request.args.get('runids').split(',')
    testid = request.args.get('testid')

    profileDir = current_app.old_config.profileDir

    idx = 0
    tlc = {}
    for rid in runids:
        sample = session.query(ts.Sample) \
                   .filter(ts.Sample.run_id == rid) \
                   .filter(ts.Sample.test_id == testid).first()
        if sample and sample.profile:
            p = sample.profile.load(profileDir)
            for k, v in p.getTopLevelCounters().items():
                tlc.setdefault(k, [None]*len(runids))[idx] = v
        idx += 1

    # If the 1'th counter is None for all keys, truncate the list.
    if all(len(k) > 1 and k[1] is None for k in tlc.values()):
        tlc = {k: [v[0]] for k, v in tlc.items()}

    return json.dumps(tlc)


@v4_route("/profile/ajax/getCodeForFunction")
def v4_profile_ajax_getCodeForFunction():
    session = request.session
    ts = request.get_testsuite()
    runid = request.args.get('runid')
    testid = request.args.get('testid')
    f = request.args.get('f')

    profileDir = current_app.old_config.profileDir

    sample = session.query(ts.Sample) \
                    .filter(ts.Sample.run_id == runid) \
                    .filter(ts.Sample.test_id == testid).first()
    if not sample or not sample.profile:
        abort(404)

    p = sample.profile.load(profileDir)
    return json.dumps([x for x in p.getCodeForFunction(f)])


@v4_route("/profile/<int:testid>/<int:run1_id>")
def v4_profile_fwd(testid, run1_id):
    return v4_profile(testid, run1_id)


@v4_route("/profile/<int:testid>/<int:run1_id>/<int:run2_id>")
def v4_profile_fwd2(testid, run1_id, run2_id=None):
    return v4_profile(testid, run1_id, run2_id)


def v4_profile(testid, run1_id, run2_id=None):
    session = request.session
    ts = request.get_testsuite()
    profileDir = current_app.old_config.profileDir

    try:
        test = session.query(ts.Test).filter(ts.Test.id == testid).one()
        run1 = session.query(ts.Run).filter(ts.Run.id == run1_id).one()
        sample1 = session.query(ts.Sample) \
                         .filter(ts.Sample.run_id == run1_id) \
                         .filter(ts.Sample.test_id == testid).first()
        if run2_id is not None:
            run2 = session.query(ts.Run).filter(ts.Run.id == run2_id).one()
            sample2 = session.query(ts.Sample) \
                             .filter(ts.Sample.run_id == run2_id) \
                             .filter(ts.Sample.test_id == testid).first()
        else:
            run2 = None
            sample2 = None
    except NoResultFound:
        # FIXME: Make this a nicer error page.
        abort(404)

    if sample1.profile:
        profile1 = sample1.profile
    else:
        profile1 = None

    if sample2 and sample2.profile:
        profile2 = sample2.profile
    else:
        profile2 = None

    json_run1 = {
        'id': run1.id,
        'order': run1.order.llvm_project_revision,
        'machine': run1.machine.name,
        'sample': sample1.id if sample1 else None
    }
    if run2:
        json_run2 = {
            'id': run2.id,
            'order': run2.order.llvm_project_revision,
            'machine': run2.machine.name,
            'sample': sample2.id if sample2 else None
        }
    else:
        json_run2 = {}
    urls = {
        'search': v4_url_for('.v4_search'),
        'singlerun_template':
            v4_url_for('.v4_profile_fwd', testid=1111, run1_id=2222)
            .replace('1111', '<testid>').replace('2222', '<run1id>'),
        'comparison_template':
            v4_url_for('.v4_profile_fwd2', testid=1111, run1_id=2222,
                       run2_id=3333)
            .replace('1111', '<testid>').replace('2222', '<run1id>')
            .replace('3333', '<run2id>'),
        'getTopLevelCounters':
            v4_url_for('.v4_profile_ajax_getTopLevelCounters'),
        'getFunctions': v4_url_for('.v4_profile_ajax_getFunctions'),
        'getCodeForFunction':
            v4_url_for('.v4_profile_ajax_getCodeForFunction'),
    }
    return render_template("v4_profile.html",
                           test=test, run1=json_run1, run2=json_run2,
                           urls=urls, **ts_data(ts))
