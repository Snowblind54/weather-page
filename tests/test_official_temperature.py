import importlib.util
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "official_temperature_updater", ROOT / "scripts" / "update_official_temperature.py"
)
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)


class NorwayTemperatureFallbackTests(unittest.TestCase):
    def test_norway_refresh_waits_about_an_hour_after_success(self):
        now = 10_000
        previous = {"sources": {"NO": {"lastFetch": now - 30 * 60}}}
        self.assertFalse(mod.norway_refresh_due(previous, now))
        previous["sources"]["NO"]["lastFetch"] = now - 60 * 60
        self.assertTrue(mod.norway_refresh_due(previous, now))

    def test_norway_refresh_waits_after_failed_attempt(self):
        now = 20_000
        previous = {"sources": {"NO": {"lastAttempt": now - 10 * 60}}}
        self.assertFalse(mod.norway_refresh_due(previous, now))

    def test_previous_norway_rows_are_trimmed_not_dropped(self):
        now = 30_000
        previous = {
            "stations": [
                {"country": "NO", "code": "A", "name": "A", "lat": 60, "lon": 10,
                 "source": "MET Norway / Seklima",
                 "rows": [[now - 4 * 3600, 1.0], [now - 3600, 2.0]]},
                {"country": "FI", "code": "B", "name": "B", "lat": 61, "lon": 25,
                 "source": "FMI", "rows": [[now - 3600, 3.0]]},
            ]
        }
        rows = mod.previous_country_stations(previous, "NO", now - mod.HISTORY_SEC, now)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["country"], "NO")
        self.assertEqual(rows[0]["rows"], [[now - 3600, 2.0]])


if __name__ == "__main__":
    unittest.main()
