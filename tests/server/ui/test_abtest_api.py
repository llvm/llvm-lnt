# Check the A/B testing REST API endpoints.
# RUN: rm -rf %t.instance
# RUN: python %{shared_inputs}/create_temp_instance.py \
# RUN:     %s %{shared_inputs}/SmallInstance \
# RUN:     %t.instance %S/Inputs/V4Pages_extra_records.sql
#
# RUN: python %s %t.instance

import json
import logging
import sys
import unittest

import lnt.server.db.migrate
import lnt.server.ui.app

logging.basicConfig(level=logging.INFO)

AUTH_TOKEN = 'test_token'
BASE_URL = 'api/db_default/v4/nts/'

CONTROL_DATA = {
    'machine': {'name': 'ab-test-machine', 'hardware': 'x86_64', 'os': 'linux'},
    'run': {
        'start_time': '2024-01-01T00:00:00',
        'end_time': '2024-01-01T00:05:00',
    },
    'tests': [
        {'name': 'SingleSource/Benchmarks/Misc/mandelbrot',
         'compile_time': 1.0, 'execution_time': 2.0},
        {'name': 'SingleSource/Benchmarks/Misc/lowercase',
         'compile_time': 0.5},
    ],
}

VARIANT_DATA = {
    'machine': {'name': 'ab-test-machine', 'hardware': 'x86_64', 'os': 'linux'},
    'run': {
        'start_time': '2024-01-01T00:10:00',
        'end_time': '2024-01-01T00:15:00',
    },
    'tests': [
        {'name': 'SingleSource/Benchmarks/Misc/mandelbrot',
         'compile_time': 1.05, 'execution_time': 1.95},
        {'name': 'SingleSource/Benchmarks/Misc/lowercase',
         'compile_time': 0.48},
    ],
}


class ABTestAPITest(unittest.TestCase):
    def setUp(self):
        _, instance_path = sys.argv
        app = lnt.server.ui.app.App.create_standalone(instance_path)
        app.testing = True
        self.client = app.test_client()

    def _post_json(self, url, body, token=AUTH_TOKEN):
        return self.client.post(url, data=json.dumps(body),
                                content_type='application/json',
                                headers={'AuthToken': token})

    def _patch_json(self, url, body, token=AUTH_TOKEN):
        return self.client.patch(url, data=json.dumps(body),
                                 content_type='application/json',
                                 headers={'AuthToken': token})

    def test_01_create_experiment(self):
        """POST /abtest creates an experiment and returns 201."""
        body = {
            'name': 'test-experiment',
            'control': CONTROL_DATA,
            'variant': VARIANT_DATA,
        }
        resp = self._post_json(BASE_URL + 'abtest', body)
        self.assertEqual(resp.status_code, 201,
                         "Expected 201, got %d: %s" %
                         (resp.status_code, resp.data))
        result = json.loads(resp.data)
        self.assertIn('id', result)
        self.assertIn('url', result)
        self.assertEqual(result['name'], 'test-experiment')
        self.assertFalse(result['pinned'])
        self.exp_id = result['id']

    def test_02_get_experiment_detail(self):
        """GET /abtest/<id> returns comparison results."""
        # First create an experiment.
        body = {
            'name': 'detail-test',
            'control': CONTROL_DATA,
            'variant': VARIANT_DATA,
        }
        resp = self._post_json(BASE_URL + 'abtest', body)
        self.assertEqual(resp.status_code, 201)
        exp_id = json.loads(resp.data)['id']

        # Now GET the detail.
        resp = self.client.get(BASE_URL + 'abtest/%d' % exp_id)
        self.assertEqual(resp.status_code, 200)
        result = json.loads(resp.data)
        self.assertIn('experiment', result)
        self.assertIn('comparisons', result)
        self.assertEqual(result['experiment']['name'], 'detail-test')
        # Both tests reported compile_time; expect two compile_time comparisons.
        cmp_by_field = {(c['test_name'], c['field']): c
                        for c in result['comparisons']}
        key = ('SingleSource/Benchmarks/Misc/mandelbrot', 'compile_time')
        self.assertIn(key, cmp_by_field,
                      "Expected mandelbrot/compile_time in comparisons")
        entry = cmp_by_field[key]
        self.assertAlmostEqual(entry['control'], 1.0)
        self.assertAlmostEqual(entry['variant'], 1.05)

    def test_03_patch_pinned(self):
        """PATCH /abtest/<id> updates the pinned field."""
        body = {
            'name': 'pin-test',
            'control': CONTROL_DATA,
            'variant': VARIANT_DATA,
        }
        resp = self._post_json(BASE_URL + 'abtest', body)
        self.assertEqual(resp.status_code, 201)
        exp_id = json.loads(resp.data)['id']

        resp = self._patch_json(BASE_URL + 'abtest/%d' % exp_id,
                                {'pinned': True})
        self.assertEqual(resp.status_code, 200)
        result = json.loads(resp.data)
        self.assertTrue(result['pinned'])

        # Verify the change is persisted.
        resp = self.client.get(BASE_URL + 'abtest/%d' % exp_id)
        self.assertEqual(resp.status_code, 200)
        detail = json.loads(resp.data)
        self.assertTrue(detail['experiment']['pinned'])

    def test_04_list_experiments(self):
        """GET /abtest lists experiments."""
        body = {
            'name': 'list-test',
            'control': CONTROL_DATA,
            'variant': VARIANT_DATA,
        }
        self._post_json(BASE_URL + 'abtest', body)

        resp = self.client.get(BASE_URL + 'abtest')
        self.assertEqual(resp.status_code, 200)
        result = json.loads(resp.data)
        self.assertIn('experiments', result)
        self.assertGreaterEqual(len(result['experiments']), 1)
        names = [e['name'] for e in result['experiments']]
        self.assertIn('list-test', names)

    def test_05_list_filter_pinned(self):
        """GET /abtest?pinned=true returns only pinned experiments."""
        # Create one pinned and one unpinned experiment.
        for name, pinned in [('pinned-exp', True), ('unpinned-exp', False)]:
            body = {
                'name': name,
                'pinned': pinned,
                'control': CONTROL_DATA,
                'variant': VARIANT_DATA,
            }
            resp = self._post_json(BASE_URL + 'abtest', body)
            self.assertEqual(resp.status_code, 201)

        resp = self.client.get(BASE_URL + 'abtest?pinned=true')
        self.assertEqual(resp.status_code, 200)
        result = json.loads(resp.data)
        self.assertTrue(all(e['pinned'] for e in result['experiments']))

    def test_06_missing_control_returns_400(self):
        """POST without control field returns 400."""
        body = {'name': 'bad', 'variant': VARIANT_DATA}
        resp = self._post_json(BASE_URL + 'abtest', body)
        self.assertEqual(resp.status_code, 400)

    def test_07_unknown_experiment_returns_404(self):
        """GET /abtest/99999 returns 404 for a missing experiment."""
        resp = self.client.get(BASE_URL + 'abtest/99999')
        self.assertEqual(resp.status_code, 404)

    def test_08_patch_requires_auth(self):
        """PATCH without auth token returns 401."""
        body = {
            'name': 'auth-test',
            'control': CONTROL_DATA,
            'variant': VARIANT_DATA,
        }
        resp = self._post_json(BASE_URL + 'abtest', body)
        self.assertEqual(resp.status_code, 201)
        exp_id = json.loads(resp.data)['id']

        resp = self._patch_json(BASE_URL + 'abtest/%d' % exp_id,
                                {'pinned': True}, token='wrong_token')
        self.assertEqual(resp.status_code, 401)


if __name__ == '__main__':
    unittest.main(argv=sys.argv[:1])
