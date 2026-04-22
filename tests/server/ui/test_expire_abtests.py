# Check lnt expire-abtests command.
# RUN: rm -rf %t.instance
# RUN: python %{shared_inputs}/create_temp_instance.py \
# RUN:     %s %{shared_inputs}/SmallInstance \
# RUN:     %t.instance %S/Inputs/V4Pages_extra_records.sql
#
# RUN: python %s %t.instance

import contextlib
import datetime
import json
import sys
import unittest

import lnt.server.db.migrate
import lnt.server.instance
import lnt.server.ui.app
from click.testing import CliRunner
from lnt.lnttool.expire_abtests import action_expire_abtests

AUTH_TOKEN = 'test_token'
BASE_URL = 'api/db_default/v4/nts/'

CONTROL_DATA = {
    'machine': {'name': 'apple-m2-macmini',
                'hardware': 'arm64', 'os': 'macosx14.0'},
    'run': {'start_time': '2024-01-01T00:00:00',
            'end_time':   '2024-01-01T00:05:00'},
    'tests': [{'name': 'CTMark/sqlite3/sqlite3.compile',
               'compile_time': 1.0}],
}

VARIANT_DATA = {
    'machine': {'name': 'apple-m2-macmini',
                'hardware': 'arm64', 'os': 'macosx14.0'},
    'run': {'start_time': '2024-01-01T00:10:00',
            'end_time':   '2024-01-01T00:15:00'},
    'tests': [{'name': 'CTMark/sqlite3/sqlite3.compile',
               'compile_time': 1.05}],
}


class ExpireABTestsTest(unittest.TestCase):
    def setUp(self):
        _, self.instance_path = sys.argv
        app = lnt.server.ui.app.App.create_standalone(self.instance_path)
        app.testing = True
        self.client = app.test_client()

    def _create_exp(self, name, pinned=False):
        body = {'name': name, 'pinned': pinned,
                'control': CONTROL_DATA, 'variant': VARIANT_DATA}
        resp = self.client.post(BASE_URL + 'abtest',
                                data=json.dumps(body),
                                content_type='application/json',
                                headers={'AuthToken': AUTH_TOKEN})
        self.assertEqual(resp.status_code, 201,
                         "POST abtest returned %d: %s" %
                         (resp.status_code, resp.data))
        return json.loads(resp.data)['id']

    def _set_created_time(self, exp_id, dt):
        """Back-date an experiment's created_time directly in the DB."""
        instance = lnt.server.instance.Instance.frompath(self.instance_path)
        with contextlib.closing(instance.get_database('default')) as db:
            session = db.make_session()
            ts = db.testsuite['nts']
            exp = session.query(ts.ABExperiment).filter_by(id=exp_id).one()
            exp.created_time = dt
            session.commit()

    def _invoke(self, *extra_args):
        runner = CliRunner()
        return runner.invoke(
            action_expire_abtests,
            [self.instance_path, '--testsuite', 'nts'] + list(extra_args))

    # ------------------------------------------------------------------ #

    def test_01_expire_only_old_unpinned(self):
        """Only old unpinned experiments are deleted; recent and pinned survive."""
        now = datetime.datetime.utcnow()
        old_id    = self._create_exp('old-unpinned')
        recent_id = self._create_exp('recent-unpinned')
        pinned_id = self._create_exp('old-pinned', pinned=True)
        self._set_created_time(old_id,    now - datetime.timedelta(days=120))
        self._set_created_time(recent_id, now - datetime.timedelta(days=10))
        self._set_created_time(pinned_id, now - datetime.timedelta(days=120))

        result = self._invoke('--older-than', '90d')
        self.assertEqual(result.exit_code, 0, result.output)
        self.assertIn('Deleted 1 experiment', result.output)
        self.assertIn('old-unpinned', result.output)

        # old-unpinned is gone.
        self.assertEqual(
            self.client.get(BASE_URL + 'abtest/%d' % old_id).status_code, 404)
        # recent and pinned are still present.
        self.assertEqual(
            self.client.get(BASE_URL + 'abtest/%d' % recent_id).status_code, 200)
        self.assertEqual(
            self.client.get(BASE_URL + 'abtest/%d' % pinned_id).status_code, 200)

    def test_02_dry_run_leaves_experiments_intact(self):
        """--dry-run reports what would be deleted but changes nothing."""
        now = datetime.datetime.utcnow()
        exp_id = self._create_exp('dry-run-target')
        self._set_created_time(exp_id, now - datetime.timedelta(days=200))

        result = self._invoke('--older-than', '90d', '--dry-run')
        self.assertEqual(result.exit_code, 0, result.output)
        self.assertIn('Would delete', result.output)
        self.assertIn('dry-run-target', result.output)
        # Experiment still exists.
        self.assertEqual(
            self.client.get(BASE_URL + 'abtest/%d' % exp_id).status_code, 200)

    def test_03_nothing_to_delete(self):
        """When nothing qualifies, a suitable message is printed."""
        result = self._invoke('--older-than', '1y')
        self.assertEqual(result.exit_code, 0, result.output)
        self.assertIn('No experiments to delete', result.output)

    def test_04_bad_age_format_exits_nonzero(self):
        """An unrecognised age string causes a non-zero exit."""
        result = self._invoke('--older-than', 'banana')
        self.assertNotEqual(result.exit_code, 0)


if __name__ == '__main__':
    unittest.main(argv=sys.argv[:1])
