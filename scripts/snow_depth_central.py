"""Official German daily snow depths and French mountain/SYNOP observations."""
import concurrent.futures as futures
import csv
import datetime as dt
import io
import json
import pathlib
import re
import urllib.parse
import zipfile

DWD='https://opendata.dwd.de/climate_environment/CDC/observations_germany/climate/daily/kl/recent/'
NIVO='https://meteofrance.s3.sbg.io.cloud.ovh.net/data/OBS/NIVOSE/nivo_{year}.csv.gz'
NIVO_META='https://static.data.gouv.fr/resources/archive-reseau-nivo-meteorologique/20260422-141208/observations-liste-postes-nivo-20250710.csv'
IMGW='https://hydro-back.imgw.pl/'
PL_STATE=pathlib.Path(__file__).resolve().parents[1]/'data/poland-snow-status.json'
NIVO_PAGE='https://www.data.gouv.fr/datasets/archive-reseau-nivo-meteorologique'

class CentralSnowDepth:
    def __init__(self,expansion):
        self.base=expansion
        self.download,self.record,self.latest=expansion.download,expansion.record,expansion.latest

    def parse_poland(self,payload,meta,now):
        if not isinstance(payload,dict):raise ValueError('IMGW station snow response changed')
        series=payload.get('snowCoverSize')
        if series is None:return []
        if not isinstance(series,list) or len(series)>1000:raise ValueError('IMGW snow-depth history changed')
        out=[];end=int(now.timestamp())
        for row in series:
            if not isinstance(row,dict) or not isinstance(row.get('date'),str) or not row['date'].endswith(('Z','+00:00')):continue
            if row.get('value') is None or isinstance(row.get('value'),bool):continue
            try:
                time=dt.datetime.fromisoformat(row['date'].replace('Z','+00:00'));value=float(row['value'])
                if not 0<=end-time.timestamp()<=7*86400:continue
                if value not in (997,998) and not 0<=value<=960:continue
                item=self.record('PL','IMGW-'+str(meta['code']),meta['name'],meta['latitude'],meta['longitude'],time.isoformat(),0 if value>=900 else value,'provisional','instant')
                if item:
                    item.update(sourceName='IMGW-PIB / official station snow observations',sourceUrl='https://hydro.imgw.pl/',
                        note='Total snow-cover thickness (snowCoverSize), in cm. Fresh snowfall and snow water equivalent are separate parameters and are not substituted. Dane IMGW-PIB zostały przetworzone; operational values are provisional.')
                    if value>=900:
                        item.update(depthCm=None,state='trace' if value==997 else 'patchy',note='Less than 0.5 cm (official IMGW code)' if value==997 else 'Discontinuous snow cover (official IMGW code)' if value==998 else 'Discontinuous cover; reported local depth '+str(int(value-900))+' cm (official IMGW code).')
                    out.append(item)
            except (ValueError,TypeError,KeyError):continue
        return self.latest(out)

    def load_poland(self,now):
        try:
            metadata=self.download(IMGW+'list/meteo')
            if not isinstance(metadata,list) or not 1<=len(metadata)<=2000:raise ValueError('IMGW station catalogue missing/oversized')
            metadata=[m for m in metadata if re.fullmatch(r'\d{9}',str(m.get('code',''))) and isinstance(m.get('latitude'),(int,float)) and isinstance(m.get('longitude'),(int,float)) and 49<=m['latitude']<=55 and 14<=m['longitude']<=25]
            try:
                attempts=json.loads(PL_STATE.read_text())
                if not isinstance(attempts,dict):attempts={}
            except (OSError,ValueError):attempts={}
            prior={s['code']:s for s in self.base.previous if s['country']=='PL' and s['code'].startswith('IMGW-')}
            end=int(now.timestamp());today=now.replace(hour=6,minute=0,second=0,microsecond=0)
            if today>now:today-=dt.timedelta(days=1)
            def collect(meta):
                code=str(meta['code']);old=prior.get('IMGW-'+code);last=attempts.get(code)
                if old and old['time']>=today.timestamp():return [old]
                if isinstance(last,(int,float)) and 0<=end-last<(3 if old else 6)*3600:return [old] if old else []
                attempts[code]=end
                try:return self.parse_poland(self.download(IMGW+'station/meteo/data2?'+urllib.parse.urlencode({'id':code})),meta,now)
                except Exception as error:
                    print('PL snow station',code,'unavailable:',str(error)[:100],flush=True)
                    return [old] if old else []
            with futures.ThreadPoolExecutor(max_workers=4) as pool:out=[s for rows in pool.map(collect,metadata) for s in rows]
            try:
                PL_STATE.parent.mkdir(parents=True,exist_ok=True);PL_STATE.write_text(json.dumps({str(m['code']):attempts[str(m['code'])] for m in metadata if str(m['code']) in attempts}))
            except OSError:print('PL snow retry cache unavailable; observations retained',flush=True)
            if out:return self.latest(out)
        except Exception as error:print('PL IMGW direct snow feed unavailable:',str(error)[:120],flush=True)
        return self.base.load_poland(now)

    def parse_germany(self,raw,code,meta,now):
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            files=[f for f in z.infolist() if re.fullmatch(r'produkt_klima_tag_\d{8}_\d{8}_'+code+r'\.txt',f.filename)]
            if len(files)!=1 or files[0].file_size>4*1024*1024:raise ValueError('Unexpected DWD daily climate snow archive')
            lines=z.read(files[0]).decode('latin1').splitlines()
        if not lines:raise ValueError('Empty DWD daily snow observations')
        fields=[v.strip() for v in lines[0].split(';')]
        if not {'STATIONS_ID','MESS_DATUM','SHK_TAG'}<=set(fields):raise ValueError('DWD daily snow columns changed')
        out=[];end=int(now.timestamp())
        for r in csv.DictReader(lines[1:],fieldnames=fields,delimiter=';'):
            if r['STATIONS_ID'].strip().zfill(5)!=code:raise ValueError('DWD daily snow station mismatch')
            try:
                day=dt.datetime.strptime(r['MESS_DATUM'].strip(),'%Y%m%d').replace(tzinfo=dt.timezone.utc)
                value=float(r['SHK_TAG'])
                if not 0<=value<997 or not 0<=end-day.timestamp()<=7*86400:continue
                item=self.record('DE','CDC-'+code,meta['name'],meta['lat'],meta['lon'],day.isoformat(),value,'provisional','day')
                if item:
                    item['note']='DWD daily total snow depth (SHK_TAG), in cm. The date identifies the observation day; collection time is not a new measurement. Operational values are provisional.'
                    out.append(item)
            except (ValueError,TypeError):continue
        return self.latest(out)

    def load_germany(self,now):
        previous=[s for s in self.base.previous if s['country']=='DE' and s['code'].startswith('CDC-')]
        yesterday=int((now.replace(hour=0,minute=0,second=0,microsecond=0)-dt.timedelta(days=1)).timestamp())
        if len(previous)>=100 and sum(s['time']>=yesterday for s in previous)>=len(previous)*.8:
            return previous  # Daily observations: do not refetch every station eight times a day.
        from update_western_temperature import dwd_metadata
        out=[]
        try:
            meta=dwd_metadata(self.download(DWD+'KL_Tageswerte_Beschreibung_Stationen.txt',False))
            listing=self.download(DWD,False).decode('utf-8')
            files=re.findall(r'href="(tageswerte_KL_(\d{5})_akt\.zip)"',listing)
            targets=[(file,code) for file,code in files if code in meta]
            if not targets or len(targets)>1000:raise ValueError('DWD daily station directory missing/oversized')
            def collect(pair):
                file,code=pair
                try:return self.parse_germany(self.download(DWD+file,False),code,meta[code],now)
                except Exception as error:
                    print('DE snow station',code,'unavailable:',str(error)[:100],flush=True)
                    return [s for s in self.base.previous if s['country']=='DE' and s['code']=='CDC-'+code]
            with futures.ThreadPoolExecutor(max_workers=6) as pool:
                out=[s for rows in pool.map(collect,targets) for s in rows]
        except Exception as error:print('DE daily snow network unavailable:',str(error)[:120],flush=True)
        if out:return self.latest(out)
        return self.base.load_dwd('DE',now)

    def nivo_metadata(self,raw):
        text=raw.decode('utf-8-sig') if isinstance(raw,bytes) else raw
        reader=csv.DictReader(io.StringIO(text))
        if not {'Latitude','Longitude','ID','Nom'}<=set(reader.fieldnames or []):raise ValueError('Météo-France mountain station catalogue changed')
        out={}
        for r in reader:
            try:
                code=r['ID'].strip().zfill(5);lat,lon=float(r['Latitude']),float(r['Longitude'])
                if re.fullmatch(r'\d{5}',code) and 41<=lat<=51.5 and -5.5<=lon<=10:out[code]={'name':r['Nom'],'lat':lat,'lon':lon}
            except (ValueError,TypeError):continue
        return out

    def parse_nivo(self,raw,metadata,now):
        text=raw.decode('utf-8-sig') if isinstance(raw,bytes) else raw
        reader=csv.DictReader(io.StringIO(text),delimiter=';')
        if not {'geo_id_wmo','validity_time','ht_neige'}<=set(reader.fieldnames or []):raise ValueError('Météo-France mountain snow columns changed')
        out=[];end=int(now.timestamp())
        for r in reader:
            code=r['geo_id_wmo'].strip().zfill(5);m=metadata.get(code)
            if not m or not r['validity_time'].endswith(('Z','+00:00')):continue
            try:
                time=dt.datetime.fromisoformat(r['validity_time'].replace('Z','+00:00'))
                value=float(r['ht_neige'])
                if not 0<=value<=15 or not 0<=end-time.timestamp()<=7*86400:continue
                item=self.record('FR','NIVO-'+code,m['name'],m['lat'],m['lon'],time.isoformat(),value*100,'provisional','instant')
                if item:
                    item.update(sourceName='Météo-France / official mountain snow observations',sourceUrl=NIVO_PAGE,
                        note='Total snow depth at the station (ht_neige), metres converted to cm. This is not fresh snowfall or a model estimate. The public archive updates daily; mountain reporting is seasonal.')
                    out.append(item)
            except (ValueError,TypeError):continue
        return self.latest(out)

    def load_france(self,now):
        out=[]
        try:out.extend(self.base.load_dwd('FR',now))
        except Exception as error:print('FR SYNOP snow unavailable:',str(error)[:120],flush=True)
        try:
            metadata=self.nivo_metadata(self.download(NIVO_META,False))
            years={now.year,(now-dt.timedelta(days=7)).year}
            for year in sorted(years):out.extend(self.parse_nivo(self.download(NIVO.format(year=year),False),metadata,now))
        except Exception as error:
            print('FR mountain snow unavailable:',str(error)[:120],flush=True)
            out.extend(s for s in self.base.previous if s['country']=='FR' and s['code'].startswith('NIVO-'))
        if not out:raise self.base.no_data('No recent official French station snow depths; mountain reports are seasonal. Missing observations are not zero snow.')
        by_station={}
        for row in out:
            key=row['code'].removeprefix('NIVO-')
            if key not in by_station or row['time']>by_station[key]['time']:by_station[key]=row
        return list(by_station.values())
