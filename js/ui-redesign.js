// Presentation-only enhancements for the weather control drawer.
// Existing control IDs and event listeners remain authoritative.
(function(){
  const PANEL_TITLES={
    tempSection:'Overlays & appearance',
    windSection:'Field, overlays & appearance',
    cloudSection:'Cloud layer & appearance',
    radarSection:'Radar & rainfall',
    snowSection:'Snow layers & history',
    cycloneSection:'Tracks & overlays',
    warningSection:'Warning layers',
    spaceWeatherSection:'Space weather',
    forecastSection:'Forecast controls',
    mapSettings:'Map appearance'
  };

  function addCardTitle(container,text){
    if(!container||container.querySelector(':scope > .panel-card-title'))return;
    const title=document.createElement('div');
    title.className='panel-card-title';
    title.textContent=text;
    container.prepend(title);
  }

  function makeSegmented(select){
    if(!select||select.dataset.segmented==='1'||select.options.length!==2)return;
    select.dataset.segmented='1';
    select.classList.add('segmented-source');
    const box=document.createElement('div');
    box.className='segmented-control';
    box.setAttribute('role','group');
    box.setAttribute('aria-label',select.getAttribute('aria-label')||'Select mode');
    const sync=()=>{
      [...box.children].forEach(button=>{
        const active=button.dataset.value===select.value;
        button.classList.toggle('selected',active);
        button.setAttribute('aria-pressed',String(active));
      });
    };
    [...select.options].forEach(option=>{
      const button=document.createElement('button');
      button.type='button';
      button.dataset.value=option.value;
      button.textContent=option.textContent;
      button.addEventListener('click',()=>{
        if(select.value===option.value)return;
        select.value=option.value;
        select.dispatchEvent(new Event('change',{bubbles:true}));
        sync();
      });
      box.appendChild(button);
    });
    select.insertAdjacentElement('afterend',box);
    select.addEventListener('change',sync);
    sync();
  }

  function enhancePanel(panel){
    panel.classList.add('modern-weather-panel');
    const details=panel.querySelector(':scope > .details');
    if(details)addCardTitle(details,PANEL_TITLES[panel.id]||'Layer controls');
    if(panel.id==='windSection'){
      const official=panel.querySelector(':scope > .official-wind-controls');
      if(official)addCardTitle(official,'Official observations');
      makeSegmented(document.getElementById('windMode'));
    }
    if(panel.id==='radarSection'){
      const accumulation=panel.querySelector(':scope > .accumulation-controls');
      if(accumulation)addCardTitle(accumulation,'Rainfall accumulation');
    }
    if(panel.id==='snowSection'){
      const history=panel.querySelector(':scope > .snow-history-controls');
      if(history)addCardTitle(history,'Snow history');
    }
  }

  document.querySelectorAll('.weather-panel').forEach(enhancePanel);

  // New panels can be inserted by optional modules after initial page load.
  new MutationObserver(records=>{
    for(const record of records){
      for(const node of record.addedNodes){
        if(!(node instanceof Element))continue;
        if(node.matches?.('.weather-panel'))enhancePanel(node);
        node.querySelectorAll?.('.weather-panel').forEach(enhancePanel);
      }
    }
  }).observe(document.body,{childList:true,subtree:true});
})();
