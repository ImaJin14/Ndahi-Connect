import { activeBundleContent } from './active-bundle.js';
import { formatExpiryCountdown } from '/shared/data-usage.js';
import { automaticPoll } from './automatic-poll.js';
let stopPrevious;
export function mountDataBalance({ call, initial, onSnapshot = () => {} }) {
  if(stopPrevious)stopPrevious();
  const host=document.getElementById('dataBalance');if(!host)return;
  let snapshot=initial,stopped=false,inPage=true,failures=0,countdown,serverTime=initial?Date.parse(initial.observedAt):Date.now(),anchor=performance.now(),expiredRequest=false;
  const relevant=()=>!stopped&&inPage&&host.isConnected&&!document.hidden&&navigator.onLine!==false&&!host.closest('[hidden]');
  const now=()=>serverTime+performance.now()-anchor;
  const draw=(paused=false)=>{if(!stopped&&host.isConnected){host.innerHTML=activeBundleContent(snapshot,{now:now(),unavailable:failures>0,paused});host.dataset.bundleObservedAt=snapshot?snapshot.observedAt:'';}};
  const tick=()=>{
    clearTimeout(countdown);if(!relevant())return;
    const v=snapshot&&snapshot.bundle;
    if(v&&v.status==='active'&&Date.parse(v.expiresAt)<=now()&&!expiredRequest){expiredRequest=true;draw();onSnapshot(null);poll.wake();}
    const pill=host.querySelector('[data-expiry-countdown]');
    if(pill&&v)pill.textContent=formatExpiryCountdown(v.expiresAt,now())||'Expiry unavailable';
    countdown=setTimeout(tick,1000);
  };
  const poll=automaticPoll({active:relevant,delay:()=>failures?Math.min(60000,15000*2**(failures-1)):15000,onPause:()=>{clearTimeout(countdown);draw(true);onSnapshot(null);},run:async context=>{
    try{const next=await call('/api/account/bundle-status',{signal:context.signal,cache:'no-store'});
      if(!context.current())return;
      if(next.version!==1||!Number.isFinite(Date.parse(next.observedAt)))throw Error('Invalid bundle evidence');
      if(snapshot&&Date.parse(next.observedAt)<Date.parse(snapshot.observedAt))return;
      snapshot=next;serverTime=Date.parse(next.observedAt);anchor=performance.now();failures=0;expiredRequest=false;draw();onSnapshot(next);tick();
    }catch(e){if(context.current()){failures++;draw();onSnapshot(null);}}
  }});
  const wake=()=>{clearTimeout(countdown);if(!host.isConnected)return stop();poll.wake();if(relevant()){draw();tick();}};
  const pageHide=()=>{inPage=false;poll.pause();clearTimeout(countdown);};
  const pageShow=()=>{inPage=true;wake();};
  const stop=()=>{stopped=true;poll.stop();clearTimeout(countdown);document.removeEventListener('visibilitychange',wake);window.removeEventListener('pagehide',pageHide);window.removeEventListener('pageshow',pageShow);for(const event of ['online','offline','hashchange'])window.removeEventListener(event,wake);};
  document.addEventListener('visibilitychange',wake);window.addEventListener('pagehide',pageHide);window.addEventListener('pageshow',pageShow);for(const event of ['online','offline','hashchange'])window.addEventListener(event,wake);
  draw();tick();poll.start();stopPrevious=stop;return stop;
}
