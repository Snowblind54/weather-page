"""Belhydromet and UHMC measured snow depth from dated official SYNOP reports.

Only section 3 4Esss is total snow depth. Missing groups, new snowfall,
snow-water equivalent and the unused 000 code are not snow-free readings.
"""
import concurrent.futures as futures
import json
from pathlib import Path
import re

from adriatic_greece_temperature import BASE, download_bulletin, observation_time

BOUNDS={'BY':(51.2,56.3,23,33),'UA':(44,52.5,22,40.5)}
BULLETINS={
    'BY':['sm/smby01.ummn..txt','sm/smby20.ummn..txt','sm/smby40.ummn..txt',
          'si/siby20.ummn..txt','si/siby21.ummn..txt','si/siby40.ummn..txt'],
    'UA':['sm/smur10.ukms..txt','sm/smur11.ukms..txt','si/siur20.ukms..txt','si/siur21.ukms..txt']}


class EasternSnowDepth:
    def __init__(self, expansion, bulletin_download=download_bulletin):
        self.base=expansion
        self.bulletin_download=bulletin_download

    def parse(self, raw, reference, expected, metadata, country, now):
        if reference.tzinfo is None or not -60<=(now-reference).total_seconds()<=7*86400:
            raise ValueError('Stale or undated snow SYNOP bulletin')
        text=raw.decode('ascii') if isinstance(raw,bytes) else raw
        if len(text)>512*1024:raise ValueError('Oversized snow SYNOP bulletin')
        header=re.match(r'\s*([A-Z]{4}\d{2})\s+([A-Z]{4})\s+(\d{6})(?:\s+[A-Z]{3})?\s*\n',text)
        if not header or (header[1],header[2])!=expected:raise ValueError('Unexpected snow SYNOP identity')
        body=text[header.end():];a=re.match(r'\s*AAXX\s+(\d{5})\s+',body)
        if not a or a[1][:4]!=header[3][:4] or int(a[1][2:4])>23:raise ValueError('Invalid snow SYNOP observation time')
        stamp=observation_time(int(a[1][:2]),int(a[1][2:4]),reference)
        if not 0<=now.timestamp()-stamp<=7*86400:return []
        out=[];south,north,west,east=BOUNDS[country]
        for report in body[a.end():].split('='):
            tokens=report.split()
            if len(tokens)<3 or tokens[0] not in metadata or not re.fullmatch(r'[0-4][\d/]{4}',tokens[1]):continue
            code=tokens[0];m=metadata[code]
            if not south<=m['lat']<=north or not west<=m['lon']<=east:continue
            section=1;groups=[];changed=False
            for group in tokens[3:]:
                if group in ('444','555'):break
                if group.startswith('222'):section=2;continue
                if group=='333':section=3;continue
                if section==3 and re.fullmatch(r'4[\d/]\d{3}',group):groups.append(group)
                if section==1 and re.fullmatch(r'9\d{4}',group):changed=True
            if changed or len(groups)!=1:continue
            value=int(groups[0][2:])
            # WMO table 3889: 000 unused; 997 trace; 998 patchy; 999 unmeasurable.
            if value in (0,999):continue
            item=self.base.record(country,code,m['name'],m['lat'],m['lon'],stamp,
                                  value if value<997 else 0,'provisional','instant')
            if not item:continue
            item['note']='Official SYNOP total snow depth (4Esss), in cm; actual UTC observation time. Reporting is seasonal. Missing groups are not zero snow.'
            if value>=997:
                item.update(depthCm=None,state='trace' if value==997 else 'patchy',
                            note='Less than 0.5 cm (official SYNOP code 997)' if value==997 else 'Snow cover is not continuous (official SYNOP code 998).')
            out.append(item)
        return self.base.latest(out)

    def load(self, country, now):
        filename='belarus_snow_stations.json' if country=='BY' else 'ukraine_temperature_stations.json'
        metadata=json.loads(Path(__file__).with_name(filename).read_text())['stations']
        out=[];failed=[]
        def collect(path):
            try:
                raw,reference=self.bulletin_download(BASE+path);parts=path.split('/')[-1].split('.')
                return self.parse(raw,reference,(parts[0].upper(),parts[1].upper()),metadata,country,now)
            except Exception as error:
                failed.append(path);print(country,'snow bulletin unavailable:',path,str(error)[:100],flush=True);return []
        with futures.ThreadPoolExecutor(max_workers=3) as pool:
            for rows in pool.map(collect,BULLETINS[country]):out.extend(rows)
        try:out.extend(self.base.load_dwd(country,now))
        except self.base.no_data:pass
        except Exception as error:
            failed.append('DWD');print(country,'snow SYNOP backup unavailable:',str(error)[:100],flush=True)
        out=[s for s in out if 0<=now.timestamp()-s['time']<=7*86400]
        if out:return self.base.latest(out)
        if failed:raise ValueError('Some official snow reports unavailable; original last successful readings retained.')
        raise self.base.no_data('No recent explicit official '+country+' snow-depth reports. Missing snow depth is not 0 cm; readings appear when reported.')

    def load_belarus(self,now):return self.load('BY',now)
    def load_ukraine(self,now):return self.load('UA',now)
