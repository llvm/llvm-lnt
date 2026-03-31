# Check that the LNT REST JSON API is working.
# create temporary instance
# RUN: rm -rf %t.instance
# RUN: %{utils}/with_postgres.sh %t.pg.log \
# RUN:     %{utils}/with_temporary_instance.py %t.instance \
# RUN:         %{shared_inputs}/base-reports \
# RUN:         %{shared_inputs}/extra-reports \
# RUN:         -- python %s %t.instance

import json
import logging
import sys
import unittest

import lnt.server.db.migrate
import lnt.server.ui.app
import copy
from V4Pages import check_json

logging.basicConfig(level=logging.DEBUG)


def check_code_post(client, url, expected_code=200, data_to_send=None):
    resp = client.post(url, follow_redirects=False, data=data_to_send)
    assert resp.status_code == expected_code, \
        "Post to %s returned: %d, not the expected %d" % (url, resp.status_code,
                                                          expected_code)
    return resp


class JSONAPIRoundTripTester(unittest.TestCase):
    """Test that LNT can accept its own data.

    We want LNT to be able to accept new runs taken from the LNT
    API itself. This allows you to do offline data processing and
    move runs between instances.  This test pulls data out of the api
    for a round trip, to make sure it can be inserted again, and
    produce a same looking run.  Database IDs etc can be different,
    but all the meaningful run fields should be the same.
    """

    def setUp(self):
        """Bind to the LNT test instance."""
        _, instance_path = sys.argv
        app = lnt.server.ui.app.App.create_standalone(instance_path)
        app.testing = True
        self.client = app.test_client()

    def test_run_round_trip(self):
        """Output of /runs/n can be fed back to /submitRun
        """
        client = self.client

        j = check_json(client, 'api/db_default/v4/nts/machines/')
        machine_id = next(m['id'] for m in j['machines']
                          if m['name'] == 'localhost__clang_DEV__x86_64')
        machine_data = check_json(client, 'api/db_default/v4/nts/machines/{}'.format(machine_id))
        first_run_id = machine_data['runs'][0]['id']
        orig_api_run = check_json(client, 'api/db_default/v4/nts/runs/{}'.format(first_run_id))

        # Do some slight modification to avoid LNT rejecting the new submission
        # as a duplicate.
        orig_api_run['run']['llvm_project_revision'] = u'154333'

        modified_run = copy.deepcopy(orig_api_run)
        modified_run['run']['llvm_project_revision'] = u'666'
        new_api_run, result_url = self._resubmit(modified_run)

        self.assertEqual(new_api_run['run']['llvm_project_revision'], u'666')
        new_api_run['run']['llvm_project_revision'] = orig_api_run['run']['llvm_project_revision']

        # We change run id and machine id back to the original and after that
        # we should have a perfect match.
        self._compare_results(new_api_run, orig_api_run)

    def _compare_results(self, after_submit_run, before_submit_run):
        """Take the results from server submission and compare them.

        We expect the IDs to change between submissions, so set the IDs to known
        values. Check all the top level keys, then check the run and machine dicts
        match and the tests data is the same.
        """
        an_id = 1234567
        before_submit_run['run']['id'] = an_id
        before_submit_run['machine']['id'] = an_id
        after_submit_run['run']['id'] = an_id
        after_submit_run['machine']['id'] = an_id
        before_submit_run['run']['order_id'] = an_id
        after_submit_run['run']['order_id'] = an_id

        self.assertEqual(list(before_submit_run.keys()), list(after_submit_run.keys()))
        # Machine and run will be dicts, compare them directly.
        for k in ['machine', 'run']:
            self.assertEqual(before_submit_run[k], after_submit_run[k])
        # The order of the tests might have changed, so sort before they are compared.
        before_submit_tests = sorted(before_submit_run['tests'],
                                     key=lambda test: test['id'])
        after_submit_tests = sorted(after_submit_run['tests'],
                                    key=lambda test: test['id'])
        for i, _ in enumerate(before_submit_tests):
            before_submit_tests[i]['run_id'] = 1234
            after_submit_tests[i]['run_id'] = 1234
            before_submit_tests[i]['id'] = 1234
            after_submit_tests[i]['id'] = 1234

            self.assertEqual(before_submit_tests[i], after_submit_tests[i])

    def _resubmit(self, run_results):
        """Send the results to the server.

        Convert the results to json, post them to the server's submitRun
        """
        # Submit the data
        data_to_send = {
            'commit': '1',
            'input_data': json.dumps(run_results)
        }
        response = check_code_post(self.client, 'db_default/v4/nts/submitRun',
                                   data_to_send=data_to_send)
        submit_result = json.loads(response.data)
        result_url = submit_result.get('result_url')
        run_id = result_url.split("/")[-1]
        new_api_run = check_json(self.client, 'api/db_default/v4/nts/runs/{}'.format(run_id))
        return new_api_run, result_url


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0], ])
