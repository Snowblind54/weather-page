import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'scripts'))
import run_official_wind as runner


class WindCycles(unittest.TestCase):
    def test_each_cycle_restores_history_before_collecting_and_publishes_last(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / 'data').mkdir()
            history = root / 'data/official-wind-history.json'
            latest = root / 'data/official-wind.json'
            history.write_text('full history')
            latest.write_text('three hours')
            commands = []
            def command(args, **kwargs):
                self.assertEqual(latest.read_text(), 'full history')
                self.assertTrue(kwargs['check'])
                self.assertEqual(kwargs['cwd'], root)
                commands.append(args)
            with patch.object(runner, 'ROOT', root), patch.object(runner.subprocess, 'run', command):
                runner.publish_cycle()
            self.assertEqual([c[1] for c in commands], [
                'scripts/update_official_wind.py', 'scripts/add_florida_coastal_wind.py',
                'scripts/split_official_wind.py', 'scripts/publish_generated_data.sh'])

    def test_failed_collection_never_publishes_partial_output(self):
        with patch.object(runner.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, 'collect')) as command:
            with self.assertRaises(subprocess.CalledProcessError): runner.publish_cycle()
            self.assertEqual(command.call_count, 1)

    def test_ten_minute_cadence_accounts_for_collection_time(self):
        with patch.object(runner, 'publish_cycle') as cycle, patch.object(runner.time, 'monotonic',
                side_effect=[0, 90, 600, 720, 1200]), patch.object(runner.time, 'sleep') as sleep:
            runner.run(3)
            self.assertEqual(cycle.call_count, 3)
            self.assertEqual([call.args[0] for call in sleep.call_args_list], [510, 480])

    def test_manual_single_cycle_does_not_wait(self):
        with patch.object(runner, 'publish_cycle') as cycle, patch.object(runner.time, 'sleep') as sleep:
            runner.run(1)
            cycle.assert_called_once()
            sleep.assert_not_called()
