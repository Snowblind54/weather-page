import sys
import threading
import subprocess
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import run_live_observations as live


class LiveObservationTests(unittest.TestCase):
    def test_timed_out_or_failed_commands_cannot_continue_to_publication(self):
        with self.assertRaises(subprocess.TimeoutExpired):
            live.execute([sys.executable,'-c','import time; time.sleep(20)'],timeout=.05)
        with self.assertRaises(subprocess.CalledProcessError):
            live.execute([sys.executable,'-c','import sys; sys.exit(3)'],timeout=5)

    def test_failed_rain_does_not_stop_temperature_or_wind_or_next_cycles(self):
        now=[0.];calls=[];restored=[];lock=threading.Lock()
        def collect(kind,deadline):
            with lock:calls.append(kind)
            if kind=='rain':raise RuntimeError('provider offline')
        live.run(cycles=3,interval=600,collect_feed=collect,restore_feed=restored.append,
                 clock=lambda:now[0],sleep=lambda seconds:now.__setitem__(0,now[0]+seconds))
        self.assertEqual(sorted(restored),sorted(live.SCOPES))
        self.assertEqual({kind:calls.count(kind) for kind in live.SCOPES},dict.fromkeys(live.SCOPES,3))
        self.assertEqual(now[0],1200)

    def test_restore_failure_retries_only_that_feed(self):
        attempts=[];collected=[]
        def restore(kind):
            attempts.append(kind)
            if kind=='rain' and attempts.count(kind)==1:raise RuntimeError('restore offline')
        live.run(cycles=2,interval=0,collect_feed=lambda k,d:collected.append(k),restore_feed=restore)
        self.assertEqual(attempts.count('rain'),2)
        self.assertEqual(collected.count('rain'),1)
        self.assertEqual(collected.count('temperature'),2)

    def test_temperature_restores_history_before_fetch_and_mirrors_both_files(self):
        c=live.commands('temperature')
        self.assertEqual(c[0][-1],'--restore')
        self.assertEqual(c[1][1],'scripts/update_official_temperature_all.py')
        self.assertEqual(c[-1][2:4],['mirror','data/official-temperature.json'])
        self.assertIn('data/official-temperature-history.json',c[-1])

    def test_waits_are_bounded_and_collector_has_a_five_hour_handover(self):
        now=[0.];waits=[];deadlines=[]
        def sleep(seconds):waits.append(seconds);now[0]+=seconds
        live.run(cycles=30,interval=600,collect_feed=lambda k,d:deadlines.append(d),
                 restore_feed=lambda k:None,clock=lambda:now[0],sleep=sleep)
        self.assertEqual(len(deadlines),90)
        self.assertEqual(set(deadlines),{18000})
        self.assertLessEqual(max(waits),30)
        self.assertEqual(now[0],17400)
