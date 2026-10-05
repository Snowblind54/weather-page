from pathlib import Path
import re


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 occurrence, got {count}")
    return text.replace(old, new, 1)

p = Path("js/app.js")
s = p.read_text(encoding="utf-8")
s = replace_once(s, "    label.insertBefore(icon,input);", "    input.insertAdjacentElement('afterend',icon);", "info icon placement")
p.write_text(s, encoding="utf-8")

p = Path("js/ui.js")
s = p.read_text(encoding="utf-8")
s = replace_once(s, "  syncTimelineCadence();\n}\nfunction positionWeatherPanel(){", "}\nfunction positionWeatherPanel(){", "close panel cadence call")
s = replace_once(s, "  positionWeatherPanel();\n  syncTimelineCadence();\n}\nfor(const button of document.querySelectorAll('[data-panel]')){", "  positionWeatherPanel();\n}\nfor(const button of document.querySelectorAll('[data-panel]')){", "open panel cadence call")
old = """function syncTimelineCadence(){
  const tenMinutes=openedWeatherPanel==='cloudSection' || $('cloudOn').checked;
  if(tenMinutes===cloudTimelineMode)return;
  stop();
  updateWeatherTimeline(tenMinutes);
  applyFrame().catch(console.error);
  if($('cloudOn').checked)scheduleCloudPrecache();
}
$('cloudOn').addEventListener('change',syncTimelineCadence);
syncTimelineCadence();

"""
s = replace_once(s, old, "", "obsolete timeline cadence block")
p.write_text(s, encoding="utf-8")

p = Path("css/style.css")
s = p.read_text(encoding="utf-8")
s = replace_once(s, "width:17px;height:17px;box-sizing:border-box;margin-right:7px;", "width:17px;height:17px;box-sizing:border-box;margin:0 7px;", "toggle info spacing")
p.write_text(s, encoding="utf-8")

p = Path("index.html")
s = p.read_text(encoding="utf-8")
s = re.sub(r"<title>Northern Weather Map v[^<]+</title>", "<title>Northern Weather Map v8.75</title>", s, count=1)
s = re.sub(r"css/style\.css\?v=[^\"']+", "css/style.css?v=8.75", s, count=1)
s = re.sub(r"js/app\.js\?v=[^\"']+", "js/app.js?v=8.75", s, count=1)
s = re.sub(r"js/ui\.js\?v=[^\"']+", "js/ui.js?v=8.75", s, count=1)
p.write_text(s, encoding="utf-8")
