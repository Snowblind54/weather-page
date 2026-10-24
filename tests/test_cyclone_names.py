"""UK naming-table gaps must use actual named warnings, never guessed dates."""
import copy
import datetime as dt
import math
from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import cyclone_names as n

NOW=dt.datetime(2026,10,24,18,30,tzinfo=dt.timezone.utc)
TABLE='''<table><tr><th>Name</th><th>Date named</th><th>Date of impact</th></tr>
<tr><td>Austen</td><td>20 October 2026</td><td></td></tr>
<tr><td>Boelo</td><td>22 October 2026</td><td></td></tr>
<tr><td>Chloe</td><td></td><td></td></tr></table>'''
URL='https://feeds.meteoalarm.org/api/v1/warnings/feeds-united-kingdom/3638dfe3-b84f-44bd-afd8-cef2288ff4d6'
CAP='''<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2"><status>Actual</status><scope>Public</scope><msgType>Update</msgType>
<info><language>en-GB</language><senderName>UK Met Office</senderName><event>Amber wind warning</event>
<headline>The strongest winds from Storm Boelo are expected Saturday evening and Sunday morning.</headline>
<description>Very strong westerly winds associated with Storm Boelo.</description>
<onset>2026-10-24T20:00:00+00:00</onset><expires>2026-10-25T10:00:00+00:00</expires>
<web>https://www.metoffice.gov.uk/weather/warnings-and-advice/uk-warnings</web>
<area><polygon>54.75,-5.63 55.34,-6.29 55.14,-7.01 54.75,-5.63</polygon></area></info></alert>'''
FEED=f'''<feed xmlns="http://www.w3.org/2005/Atom" xmlns:cap="urn:oasis:names:tc:emergency:cap:1.2">
<id>urn:oid:UK</id><entry><cap:status>Actual</cap:status><cap:event>Amber wind warning</cap:event>
<link type="application/cap+xml" href="{URL}"/></entry></feed>'''

def distance(a,b):
    r=math.pi/180
    return 6371*2*math.asin(min(1,math.sqrt(math.sin((b['lat']-a['lat'])*r/2)**2+math.cos(a['lat']*r)*math.cos(b['lat']*r)*math.sin((b['lon']-a['lon'])*r/2)**2)))

class NamingFallback(unittest.TestCase):
    def download(self,url):
        return {n.UK_SOURCE:TABLE,n.UK_WARNINGS:FEED,n.MET_SOURCE:'{"features":[]}',URL:CAP}[url].encode()

    def test_blank_impact_date_uses_named_cap_validity(self):
        self.assertEqual(n.parse_uk(TABLE,NOW),[])
        events=n.uk_catalogue(TABLE.encode(),NOW,self.download)
        self.assertEqual(len(events),1);e=events[0]
        self.assertEqual(e['name'],'Boelo')
        self.assertEqual(e['start'],int(dt.datetime(2026,10,24,20,tzinfo=dt.timezone.utc).timestamp()))
        self.assertEqual(e['end'],int(dt.datetime(2026,10,25,10,tzinfo=dt.timezone.utc).timestamp()))
        self.assertEqual(e['warningUrl'],URL)
        self.assertIn('CAP',e['impactSource'])

    def test_unused_names_expired_warnings_tests_rain_and_multiple_names_do_not_match(self):
        known=n.pending_uk_names(TABLE,NOW)
        self.assertEqual(set(known),{'austen','boelo'})
        for raw in [CAP.replace('Boelo','Chloe'),CAP.replace('Actual','Test'),CAP.replace('Update','Cancel'),
                    CAP.replace('Public','Restricted'),CAP.replace('Amber wind warning','Amber rain warning'),
                    CAP.replace('UK Met Office','Unknown'),CAP.replace('Storm Boelo.','Storm Boelo and Storm Austen.'),
                    CAP.replace('2026-10-25T10:00:00+00:00','2026-10-24T10:00:00+00:00'),
                    CAP.replace('2026-10-24T20:00:00+00:00','2026-10-24T20:00:00'),
                    CAP.replace('54.75,-5.63','24.75,-55.63')]:
            with self.subTest(raw=raw):self.assertEqual(n.parse_uk_cap(raw,known,NOW,URL),[])

    def test_external_warning_links_and_wrong_country_feed_are_rejected(self):
        calls=[]
        def download(url):
            calls.append(url);return FEED.replace(URL,'https://example.com/private').encode()
        self.assertEqual(n.uk_catalogue(TABLE.encode(),NOW,download),[])
        self.assertEqual(calls,[n.UK_WARNINGS])
        with self.assertRaises(ValueError):n.uk_catalogue(TABLE.encode(),NOW,lambda u:FEED.replace('urn:oid:UK','urn:oid:IE').encode())
        events=n.parse_uk_cap(CAP.replace('https://www.metoffice.gov.uk/weather/warnings-and-advice/uk-warnings','https://example.com/fake'),n.pending_uk_names(TABLE,NOW),NOW,URL)
        self.assertEqual(events[0]['url'],n.UK_SOURCE)

    def test_unique_track_matches_and_distinct_lows_remain_unmatched(self):
        points=[{'time':int(NOW.timestamp())+h*3600,'lat':56,'lon':-8,'pressure':947,'nearbyGust':32} for h in (2,3,4)]
        tracks=[{'id':'boelo-track','points':points}]
        result=n.add_european_names(tracks,NOW,self.download,distance)
        self.assertEqual(result['matched'],1);self.assertEqual(tracks[0]['name'],'Boelo')
        self.assertEqual(result['sources'][0]['namedEvents'],1)
        two=[{'id':'one','points':points},{'id':'two','points':copy.deepcopy(points)}]
        self.assertEqual(n.add_european_names(two,NOW,self.download,distance)['matched'],0)
        self.assertTrue(all('name' not in s for s in two))
        tropical=[{'points':points,'nhc':{'name':'Other'}}]
        self.assertEqual(n.add_european_names(tropical,NOW,self.download,distance)['matched'],0)

    def test_separate_warning_regions_cannot_put_one_name_on_two_tracks(self):
        extra=URL[:-1]+'7'
        feed=FEED.replace('</feed>',FEED[FEED.index('<entry>'):FEED.index('</feed>')].replace(URL,extra)+'</feed>')
        def dl(url):
            if url==n.UK_WARNINGS:return feed.encode()
            if url==extra:return CAP.replace('54.75','59.75').replace('55.34','60.34').replace('55.14','60.14').encode()
            return self.download(url)
        def track(lat):return {'points':[{'time':int(NOW.timestamp())+h*3600,'lat':lat,'lon':-6,'pressure':947,'nearbyGust':32} for h in (2,3,4)]}
        tracks=[track(54),track(61)]
        # With the 450 km matching radius, these two warning areas have
        # distinct nearby lows; neither can safely receive the name.
        self.assertEqual(n.add_european_names(tracks,NOW,dl,distance)['matched'],0)

if __name__=='__main__':unittest.main()
