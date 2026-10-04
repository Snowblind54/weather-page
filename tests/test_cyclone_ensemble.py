import datetime as dt
import pathlib
import sys
import unittest
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'scripts'))
import update_cyclone_ensemble as e

STAMP = int(dt.datetime(2026,10,4,12,tzinfo=dt.timezone.utc).timestamp())


def track(id='GFS-test', offset=0, lon=-30):
    return {'id':id,'points':[{'time':STAMP+h*3600,'lat':55+offset,'lon':lon+h*.2,'pressure':985} for h in e.STEPS]}


class Ensemble(unittest.TestCase):
    def test_pressure_byte_range_uses_only_mean_sea_level(self):
        index='1:0:d=x:PRES:surface:6 hour fcst\n2:123:d=x:PRMSL:mean sea level:6 hour fcst\n3:456:d=x:TMP:2 m above ground:x\n'
        self.assertEqual(e.pressure_range(index),(123,455))
        self.assertEqual(e.pressure_range(index.split('\n3:')[0]),(123,None))
        with self.assertRaises(ValueError):e.pressure_range('1:0:d=x:PRES:surface:x')

    def test_consistent_matching_rejects_remote_and_ambiguous_lows(self):
        reference=track();member=track(offset=.5)
        self.assertIs(e.match_member([reference],[member])['GFS-test'],member)
        self.assertEqual(e.match_member([reference],[track(offset=10)]),{})
        self.assertEqual(e.match_member([reference],[member,track(offset=.55)]),{})
        self.assertEqual(e.match_member([reference,track('GFS-other',offset=.05)],[member]),{})

    def test_members_cannot_be_assigned_to_two_gfs_systems(self):
        a,b=track('A'),track('B',lon=-45)
        matched=e.match_member([a,b],[track(offset=.1),track(offset=.1,lon=-45)])
        self.assertEqual(set(matched),{'A','B'})
        self.assertIsNot(matched['A'],matched['B'])

    def test_short_overlap_is_not_treated_as_track_confidence(self):
        member=track();member['points']=member['points'][:2]
        self.assertIsNone(e.match_score(track(),member))

    def test_spread_requires_support_and_does_not_bridge_missing_centres(self):
        members=[track(offset=i*.02) for i in range(31)]
        frames=e.spread_frames(members,STAMP,31)
        self.assertEqual(len(frames),17)
        self.assertEqual(frames[0]['support'],31)
        self.assertGreater(frames[0]['radiusKM'],0)
        self.assertEqual(e.spread_frames(members[:9],STAMP,31),[])
        for t in members[:20]:t['points']=[p for p in t['points'] if p['time']!=STAMP+12*3600]
        self.assertNotIn(STAMP+12*3600,[f['time'] for f in e.spread_frames(members,STAMP,31)])

    def test_outlier_does_not_turn_spread_into_maximum_extent(self):
        members=[track(offset=0) for _ in range(30)]+[track(offset=8)]
        self.assertEqual(e.spread_frames(members,STAMP,31)[0]['radiusKM'],0)

    def test_partial_ensemble_is_disclosed_and_gfs_path_is_preserved(self):
        gfs={'modelRun':STAMP,'systems':[track()]}
        original=str(gfs)
        result=e.build_snapshot(gfs,{m:[track(offset=.2)] for m in e.MEMBERS[:25]},dt.datetime.fromtimestamp(STAMP,dt.timezone.utc))
        self.assertEqual(str(gfs),original)
        self.assertEqual(result['status'],'partial')
        self.assertEqual(result['availableMembers'],25)
        self.assertEqual(len(result['systems'][0]['members']),25)
        self.assertEqual(result['spreadPercentile'],80)


if __name__=='__main__':unittest.main()
