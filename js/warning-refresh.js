// An open map must fetch new alerts as well as remove expired ones.
let warningAutoRefreshPending=false;
async function refreshVisibleWarnings(){
  if(document.hidden || !$('warningOn').checked || warningAutoRefreshPending)return;
  warningAutoRefreshPending=true;
  try{await loadWarnings(false);}catch(error){console.warn(error);}
  finally{warningAutoRefreshPending=false;}
}
setInterval(refreshVisibleWarnings,5*60*1000);
document.addEventListener('visibilitychange',refreshVisibleWarnings);
