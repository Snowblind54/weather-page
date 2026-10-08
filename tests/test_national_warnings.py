"""Deterministic checks for official warning parsing, polygons, and expiry."""
import datetime as dt
import pathlib
import sys
import unittest
from unittest.mock import patch

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

    def test_greenland_official_region_and_validity(self):
        boundary = {'features': [{'properties': {'komkode': 3900, 'komnavn': 'Nuuk'},
                                  'geometry': SHAPE}]}
        alert = {'formattedCategory': 3, 'warningTitle': 'Piteraq', 'warningText': 'Official DMI alert',
                 'validFrom': '2026-10-03T07:00:00Z', 'validTo': '2026-10-03T12:00:00Z'}
        group = {'id': 3900, 'name': 'Nuuk', 'municipalityWarnings': [alert]}
        rows = warnings.parse_denmark({'warningActual': [group], 'warning5days': [group]}, boundary, NOW, 'Greenland')
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['country'], 'Greenland')
        self.assertEqual(rows[0]['flag'], '🇬🇱')
        self.assertEqual(rows[0]['level'], 'Extreme')
        self.assertEqual(rows[0]['sourceUrl'], warnings.GREENLAND_FEED)
        self.assertEqual(len(rows[0]['polygons']), 2)

    def test_canada_information_colours_and_message_expiry(self):
        properties = {'alert_type': 'statement', 'alert_name_en': 'Special weather statement',
                      'publication_datetime': '2026-10-03T07:00:00Z',
                      'validity_datetime': '2026-10-04T01:00:00Z',
                      'event_end_datetime': '2026-10-04T10:00:00Z',
                      'expiration_datetime': '2026-10-03T12:00:00Z',
                      'province': 'BC', 'feature_name_en': 'North coast', 'alert_text_en': 'Heavy snow possible'}
        feature = {'id': 'zone:SPS', 'properties': properties, 'geometry': SHAPE}
        payload = {'type': 'FeatureCollection', 'features': [feature]}
        row = warnings.parse_canada(payload, NOW)[0]
        self.assertEqual(row['level'], 'Information')
        self.assertEqual(row['alertType'], 'Statement')
        self.assertEqual(row['timeZone'], 'America/Vancouver')
        self.assertEqual(len(row['polygons'][0]), 2)
        self.assertEqual(row['expires'], '2026-10-04T10:00:00+00:00')
        self.assertEqual(warnings.parse_canada(payload, NOW + dt.timedelta(hours=4)), [])
        for colour, level in [('yellow', 'Moderate'), ('orange', 'Severe'), ('red', 'Extreme')]:
            properties.update(alert_type='warning', risk_colour_en=colour)
            self.assertEqual(warnings.parse_canada(payload, NOW)[0]['level'], level)
        properties['status_en'] = 'cancelled'
        self.assertEqual(warnings.parse_canada(payload, NOW), [])

    def test_canada_pagination_and_wrong_host(self):
        page = {'type': 'FeatureCollection', 'features': []}
        link = {'rel': 'next', 'href': '/collections/weather-alerts/items?offset=1000'}
        with patch.object(warnings, 'download_json', side_effect=[{**page, 'links': [link]}, page]) as request:
            self.assertEqual(warnings.canada_payload(), page)
            self.assertEqual(request.call_count, 2)
        link['href'] = 'https://example.com/alerts'
        with patch.object(warnings, 'download_json', return_value={**page, 'links': [link]}):
            with self.assertRaisesRegex(ValueError, 'pagination URL'):
                warnings.canada_payload()


if __name__ == '__main__':
    unittest.main()
