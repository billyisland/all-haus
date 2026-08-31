// Traffology page script — reader session tracking
// Source: web/src/lib/traffology.ts
;(function(){
if(typeof window==='undefined'||!navigator.sendBeacon)return;
var BEACON_URL='/ingest/beacon',HEARTBEAT_MS=30000,IDLE_MS=30000,SCROLL_MS=200;
var el=document.querySelector('[data-traffology-article-id]');
if(!el)return;
var articleId=el.getAttribute('data-traffology-article-id');
if(!articleId)return;
var sk='traf_'+articleId,sessionToken=sessionStorage.getItem(sk);
if(!sessionToken){sessionToken=crypto.randomUUID();sessionStorage.setItem(sk,sessionToken)}
var maxScroll=0,activeSec=0,lastActive=Date.now(),isActive=true;
var scrollT=null,idleT=null,hbT=null;
function subStatus(){var s=document.querySelector('[data-traffology-subscriber]');return s?s.getAttribute('data-traffology-subscriber')||'anonymous':'anonymous'}
function utm(){var p=new URLSearchParams(window.location.search);return{utmSource:p.get('utm_source')||void 0,utmMedium:p.get('utm_medium')||void 0,utmCampaign:p.get('utm_campaign')||void 0}}
function updScroll(){var t=window.scrollY||document.documentElement.scrollTop,h=document.documentElement.scrollHeight-window.innerHeight;if(h>0){var d=Math.min(1,t/h);if(d>maxScroll)maxScroll=d}}
window.addEventListener('scroll',function(){if(!scrollT)scrollT=setTimeout(function(){updScroll();scrollT=null},SCROLL_MS)},{passive:true});
function goActive(){if(!isActive){isActive=true;lastActive=Date.now()}if(idleT)clearTimeout(idleT);idleT=setTimeout(goIdle,IDLE_MS)}
function goIdle(){if(isActive){activeSec+=Math.round((Date.now()-lastActive)/1000);isActive=false}}
document.addEventListener('visibilitychange',function(){document.hidden?goIdle():goActive()});
['scroll','click','keydown','mousemove','touchstart'].forEach(function(e){document.addEventListener(e,goActive,{passive:true})});
function send(type){if(isActive){activeSec+=Math.round((Date.now()-lastActive)/1000);lastActive=Date.now()}
var p={sessionToken:sessionToken,articleId:articleId,type:type,timestamp:Date.now(),scrollDepth:Math.round(maxScroll*1000)/1000,readingTimeSeconds:activeSec};
if(type==='init'){p.referrerUrl=document.referrer||void 0;p.screenWidth=window.innerWidth;p.subscriberStatus=subStatus();var u=utm();if(u.utmSource)p.utmSource=u.utmSource;if(u.utmMedium)p.utmMedium=u.utmMedium;if(u.utmCampaign)p.utmCampaign=u.utmCampaign}
navigator.sendBeacon(BEACON_URL,new Blob([JSON.stringify(p)],{type:'application/json'}))}
updScroll();goActive();send('init');
hbT=setInterval(function(){send('heartbeat')},HEARTBEAT_MS);
document.addEventListener('visibilitychange',function(){if(document.hidden){send('unload');if(hbT){clearInterval(hbT);hbT=null}}else if(!hbT){send('heartbeat');hbT=setInterval(function(){send('heartbeat')},HEARTBEAT_MS)}});
window.addEventListener('pagehide',function(){send('unload')});
})();
