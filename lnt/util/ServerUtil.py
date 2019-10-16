"""
Utility for submitting files to a web server over HTTP.
"""
import sys
import urllib.request
import urllib.parse
import urllib.error
import contextlib
import json
import ssl
import certifi
import lnt.server.instance

# FIXME: I used to maintain this file in such a way that it could be used
# separate from LNT to do submission. This could be useful for adapting an
# older system to report to LNT, for example. It might be nice to factor the
# simplified submit code into a separate utility.


def _show_json_error(reply):
    try:
        error = json.loads(reply)
    except ValueError:
        print("error: {}".format(reply))
        return
    sys.stderr.write("error: lnt server: {}\n".format(error.get('error')))
    message = error.get('message', '')
    if message:
        sys.stderr.write(message + '\n')


def submitFileToServer(url, file, select_machine=None, merge_run=None,
                       ignore_regressions=False):
    with open(file, 'rb') as f:
        values = {
            'input_data': f.read(),
            'commit': "1",  # compatibility with old servers.
        }
        if select_machine is not None:
            values['select_machine'] = select_machine
        if merge_run is not None:
            values['merge'] = merge_run
        if ignore_regressions:
            values['ignore_regressions'] = True
    headers = {'Accept': 'application/json'}
    data = urllib.parse.urlencode(values).encode(encoding='ascii')
    try:
        context = ssl.create_default_context(cafile=certifi.where())
        response = urllib.request.urlopen(urllib.request.Request(url, data, headers=headers), context=context)
    except urllib.error.HTTPError as e:
        _show_json_error(e.read())
        return
    except urllib.error.URLError as e:
        sys.stderr.write("error: could not resolve '%s': %s\n" %
                         (url, e))
        return
    result_data = response.read()

    # The result is expected to be a JSON object.
    try:
        return json.loads(result_data)
    except Exception:
        import traceback
        print("Unable to load result, not a valid JSON object.")
        print()
        print("Traceback:")
        traceback.print_exc()
        print()
        print("Result:")
        print("error:", result_data)
        return


def submitFileToInstance(path, file, select_machine=None, merge_run=None,
                         testsuite=None, ignore_regressions=False):
    # Otherwise, assume it is a local url and submit to the default database
    # in the instance.
    instance = lnt.server.instance.Instance.frompath(path)
    config = instance.config
    db_name = 'default'
    with contextlib.closing(config.get_database(db_name)) as db:
        if db is None:
            raise ValueError("no default database in instance: %r" % (path,))
        session = db.make_session()
        return lnt.util.ImportData.import_and_report(
            config, db_name, db, session, file, format='<auto>',
            ts_name=testsuite or 'nts', select_machine=select_machine,
            merge_run=merge_run, ignore_regressions=ignore_regressions)


def submitFile(url, file, verbose, select_machine=None, merge_run=None,
               testsuite=None, ignore_regressions=False):
    # If this is a real url, submit it using urllib.
    if '://' in url:
        result = submitFileToServer(url, file, select_machine, merge_run,
                                    ignore_regressions)
    else:
        result = submitFileToInstance(url, file, select_machine, merge_run,
                                      testsuite, ignore_regressions)
    return result


def submitFiles(url, files, verbose, select_machine=None, merge_run=None,
                testsuite=None, ignore_regressions=False):
    results = []
    for file in files:
        result = submitFile(url, file, verbose, select_machine=select_machine,
                            merge_run=merge_run, testsuite=testsuite,
                            ignore_regressions=ignore_regressions)
        if result:
            results.append(result)
    return results
