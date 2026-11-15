import datetime as dt
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import run_warning_updates as live


class WarningUpdates(unittest.TestCase):
    def test_ten_minute_cadence_is_independent_of_cron_and_stops_before_runner_limit(self):
        clock = [0.]
        calls, waits = [], []
        def collect(deadline):
            calls.append((clock[0], deadline))
            clock[0] += 75
            if len(calls) == 1:
                raise RuntimeError('temporary failure')
        def sleep(seconds):
            waits.append(seconds)
            clock[0] += seconds
        live.run(collect_cycle=collect, clock=lambda: clock[0], sleep=sleep)
        self.assertEqual(len(calls), 30)
        self.assertEqual([c[0] for c in calls], [i*600 for i in range(30)])
        self.assertEqual({c[1] for c in calls}, {18000})
        self.assertLess(clock[0], 18000)
        self.assertLessEqual(max(waits), 30)

    def test_bootstrap_runs_once_without_waiting_before_handover(self):
        calls = []
        live.run(cycles=1, collect_cycle=lambda d:calls.append(d), clock=lambda:0,
                 sleep=lambda s:self.fail('bootstrap must not sleep'))
        self.assertEqual(calls, [18000])

    def collect(self, failed=None, stale=None, publication_failure=False):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        (root/'data').mkdir()
        calls = []
        now = 1800000000
        def execute(command, timeout):
            calls.append(command)
            self.assertLessEqual(timeout, 240)
            if command[1].startswith('scripts/update_'):
                kind = 'latvia' if 'latvia' in command[1] else 'national'
                if kind == failed:
                    raise TimeoutError('upstream unavailable')
                stamp = now - 3600 if kind == stale else now
                (root/live.FEEDS[kind][1]).write_text(json.dumps({
                    'version': 1, 'updatedAt': dt.datetime.fromtimestamp(stamp, dt.timezone.utc).isoformat()}))
            elif command[0] == 'bash' and publication_failure:
                raise RuntimeError('primary publication failed')
        result = live.collect(1000, execute_command=execute, clock=lambda:0,
                              wall_clock=lambda:now, root=root)
        return result, calls

    def test_latvia_failure_does_not_stop_national_updates_or_publish_old_latvia(self):
        result, calls = self.collect(failed='latvia')
        self.assertTrue(result)
        self.assertEqual(calls[-2][-1], 'data/national-warnings.json')
        self.assertEqual(calls[-1], ['python3', 'scripts/github_fallback.py', 'mirror', 'data/national-warnings.json'])

    def test_successful_feeds_publish_together_and_use_existing_guarded_publisher(self):
        result, calls = self.collect()
        self.assertTrue(result)
        self.assertEqual(calls[-2][:2], ['bash', 'scripts/publish_generated_data.sh'])
        self.assertEqual(calls[-2][-2:], ['data/latvia-warnings.json', 'data/national-warnings.json'])
        self.assertEqual(calls[-1][-2:], calls[-2][-2:])

    def test_old_file_is_not_republished_as_a_new_collection(self):
        result, calls = self.collect(failed='latvia', stale='national')
        self.assertFalse(result)
        self.assertEqual(len(calls), 2)

    def test_independent_mirror_is_attempted_after_publication_error(self):
        result, calls = self.collect(publication_failure=True)
        self.assertTrue(result)
        self.assertEqual(calls[-1][2], 'mirror')

    def test_failed_partial_write_restores_last_successful_input(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root/'data').mkdir()
            old = b'{"version":1,"updatedAt":"2026-11-15T03:12:10+00:00","countries":{}}'
            path = root/'data/national-warnings.json'
            path.write_bytes(old)
            def execute(command, timeout):
                if command[1] == 'scripts/update_national_warnings.py':
                    path.write_bytes(b'{"version":')
                raise TimeoutError('interrupted write')
            self.assertFalse(live.collect(100, execute_command=execute, clock=lambda:0, root=root))
            self.assertEqual(path.read_bytes(), old)
            self.assertFalse((root/'data/latvia-warnings.json').exists())

    def test_cancelled_workflows_do_not_restart_and_successors_do_not_rely_on_cron(self):
        workflow = (live.ROOT/'.github/workflows/update-latvia-warnings.yml').read_text()
        self.assertIn('actions: write', workflow)
        self.assertIn('gh workflow run update-latvia-warnings.yml', workflow)
        self.assertIn('timeout-minutes: 330', workflow)
        self.assertIn("vars.WARNING_UPDATES_PAUSED != 'true'", workflow)
        self.assertNotIn('if: ${{ always()', workflow)
        self.assertIn('--cycles 1', workflow)
        self.assertIn('--cycles 30', workflow)
