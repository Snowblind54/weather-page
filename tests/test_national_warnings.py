"""Deterministic checks for official warning parsing, polygons, and expiry."""
import datetime as dt
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'scripts'))
import update_national_warnings as warnings

NOW = dt.datetime(2026, 10, 3, 8, 0, tzinfo=dt.timezone.utc)
# Keep a second island and a polygon hole, not merely its enclosing rectangle.
SHAPE = {'type': 'MultiPolygon', 'coordinates': [
    [[[14, 52], [15, 52], [15, 53], [14, 52]],
     [[14.2, 52.2], [14.3, 52.2], [14.3, 52.3], [14.2, 52.2]]],
    [[[15.1, 52], [15.2, 52], [15.2, 52.1], [15.1, 52]]]]}


class NationalWarnings(unittest.TestCase):
    def test_local_time_and_explicit_offset(self):
        self.assertEqual(warnings.timestamp('2026-10-03 10:30', 'Europe/Warsaw'), '2026-10-03T10:30:00+02:00')
        self.assertEqual(warnings.timestamp('2026-12-03 10:30', 'Europe/Copenhagen'), '2026-12-03T10:30:00+01:00')
        self.assertEqual(warnings.timestamp('2026-10-25T02:30:00+01:00', 'Europe/Copenhagen'), '2026-10-25T02:30:00+01:00')
        with self.assertRaises(ValueError):
            warnings.timestamp(None, 'Europe/Warsaw')

    def test_poland_county_mapping_expiry_and_severity(self):
        boundary = {'features': [{'properties': {'jpt_kod_je': '0226', 'jpt_nazwa_': 'złotoryjski'}, 'geometry': SHAPE}]}
        data = {'warnings': {}, 'teryt': {'0226': []}}
        for level in (1, 2, 3):
            identifier = str(level)
            data['warnings'][identifier] = {'Level': level, 'PhenomenonName': 'Strong wind',
                'ValidFrom': '2026-10-03 09:00', 'ValidTo': '2026-10-03 12:00',
                'LxValidTo': '2026-10-03T12:00:01+02:00', 'Content': '<p>Official forecast</p>'}
            data['teryt']['0226'].append(identifier)
        rows = warnings.parse_poland(data, boundary, NOW)
        self.assertEqual([r['level'] for r in rows], ['Moderate', 'Severe', 'Extreme'])
        self.assertEqual(rows[0]['expires'], '2026-10-03T12:00:01+02:00')
        self.assertEqual(rows[0]['polygons'][0][0][0], [52, 14])
        self.assertEqual(len(rows[0]['polygons']), 2)
        self.assertEqual(len(rows[0]['polygons'][0]), 2)
        expiry = dt.datetime(2026, 10, 3, 10, 0, 1, tzinfo=dt.timezone.utc)
        self.assertEqual(warnings.parse_poland(data, boundary, expiry), [])
        with self.assertRaisesRegex(ValueError, 'geometry missing'):
            warnings.parse_poland(data, {'features': []}, NOW)

    def test_denmark_coastal_geometry_dedup_and_risk_exclusion(self):
        boundary = {'features': [{'properties': {'komkode': 5010, 'komnavn': 'Sydlige Lillebælt'}, 'geometry': SHAPE}]}
        alert = {'formattedCategory': 2, 'warningTitle': 'High water', 'warningText': 'Coastal warning',
                 'validFrom': '2026-10-03T09:00:00+02:00', 'validTo': '2026-10-03T11:00:00+02:00'}
        group = {'id': '5010', 'name': 'Sydlige Lillebælt', 'municipalityWarnings': [alert, {**alert, 'formattedCategory': 0}]}
        data = {'warningActual': [group], 'warning5days': [group]}
        rows = warnings.parse_denmark(data, boundary, NOW)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['level'], 'Severe')
        self.assertEqual(rows[0]['sourceName'], 'Danish Meteorological Institute (DMI)')
        self.assertEqual(warnings.parse_denmark(data, boundary, NOW + dt.timedelta(hours=1)), [])
        with self.assertRaisesRegex(ValueError, 'geometry missing'):
            warnings.parse_denmark(data, {'features': []}, NOW)

    def test_no_warning_and_bad_schema(self):
        self.assertEqual(warnings.parse_poland({'warnings': {}, 'teryt': {}}, {}, NOW), [])
        self.assertEqual(warnings.parse_denmark({'warningActual': [], 'warning5days': []}, {}, NOW), [])
        with self.assertRaises(ValueError):
            warnings.parse_denmark({}, {}, NOW)
        with self.assertRaises(ValueError):
            warnings.parse_poland({}, {}, NOW)


if __name__ == '__main__':
    unittest.main()
