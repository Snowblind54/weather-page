from pathlib import Path

path = Path('js/official-wind.js')
text = path.read_text()

replacements = [
    ('function validateOfficialWind(data){', 'function validateOfficialWind(data,{maxRows=200}={}){'),
    ('!Array.isArray(s.rows)||s.rows.length>200)', '!Array.isArray(s.rows)||s.rows.length>maxRows)'),
    ("officialWindHistoryData=validateOfficialWind(await r.json());return officialWindHistoryData;", "officialWindHistoryData=validateOfficialWind(await r.json(),{maxRows:1500});return officialWindHistoryData;"),
]
for old, new in replacements:
    if old not in text:
        raise SystemExit(f'Expected official-wind text not found: {old}')
    text = text.replace(old, new, 1)

old_function = '''async function loadOfficialWindPopupHistory(root,s,endUnix){
  const panel=root?.querySelector?.('.official-wind-history');if(!panel)return;
  if(officialWindHistoryData){panel.innerHTML=officialWindHistoryPanel(s,endUnix);requestAnimationFrame(()=>map._popup?.update?.());return;}
  panel.innerHTML='<div class="wind-popup-meta" style="padding:10px 0 2px">Loading 24 h measured history…</div>';
  try{
    const data=await loadOfficialWindHistory(),station=data.stations.find(item=>item.country===s.country&&item.code===s.code);
    panel.innerHTML=station?officialWindHistoryGraph(station,endUnix):'<div class="wind-popup-meta" style="padding:10px 0 2px">24 h measured history is unavailable for this station.</div>';
  }catch(error){panel.innerHTML='<div class="wind-popup-meta" style="padding:10px 0 2px">24 h measured history could not load.</div>';console.warn('Official wind history unavailable',error.message);}
  requestAnimationFrame(()=>map._popup?.update?.());
}
'''
if old_function not in text:
    raise SystemExit('Expected old popup history helper not found')
text = text.replace(old_function, '', 1)

old_popup = '''      marker.on('popupopen',e=>{
        const attach=(attempt=0)=>{
          const root=e.popup.getElement();
          if(!root){if(attempt<4)setTimeout(()=>attach(attempt+1),0);return;}
          L.DomEvent.disableClickPropagation(root);L.DomEvent.disableScrollPropagation(root);
          loadOfficialWindPopupHistory(root,s,r[0]);
        };
        requestAnimationFrame(()=>attach());
      });marker.addTo(officialWindLabels);
'''
new_popup = '''      marker.on('popupopen',e=>{
        const root=e.popup.getElement();
        if(root){L.DomEvent.disableClickPropagation(root);L.DomEvent.disableScrollPropagation(root);}
        const refresh=()=>{
          if(!marker.isPopupOpen())return;
          marker.setPopupContent(officialWindPopup(s,r));
          marker.getPopup()?.update?.();
        };
        if(officialWindHistoryData){refresh();return;}
        loadOfficialWindHistory().then(refresh).catch(error=>{
          console.warn('Official wind history unavailable',error.message);
          if(!marker.isPopupOpen())return;
          marker.setPopupContent(officialWindPopup(s,r).replace('Loading 24 h measured history…','24 h measured history could not load.'));
          marker.getPopup()?.update?.();
        });
      });marker.addTo(officialWindLabels);
'''
if old_popup not in text:
    raise SystemExit('Expected old marker popup handler not found')
text = text.replace(old_popup, new_popup, 1)
text = text.replace("'v8.127'", "'v8.128'", 1)
path.write_text(text)

path = Path('js/auto-refresh.js')
text = path.read_text()
if "'v8.127'" not in text:
    raise SystemExit('Expected auto-refresh version not found')
path.write_text(text.replace("'v8.127'", "'v8.128'", 1))

path = Path('index.html')
text = path.read_text()
for old, new in [
    ('<title>Northern Weather Map v8.127</title>', '<title>Northern Weather Map v8.128</title>'),
    ('js/official-wind.js?v=8.127', 'js/official-wind.js?v=8.128'),
    ('js/auto-refresh.js?v=8.127', 'js/auto-refresh.js?v=8.128'),
]:
    if old not in text:
        raise SystemExit(f'Expected index text not found: {old}')
    text = text.replace(old, new, 1)
path.write_text(text)
