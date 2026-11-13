const api=window.NDAHI_CONFIG && window.NDAHI_CONFIG.apiUrl;
if(api)fetch(api+"/api/home/config",{credentials:"include"}).then(async response=>{
 if(!response.ok)return;const info=await response.json();if(!info.enabled)return;
 const section=document.createElement("section");section.className="surface";
 const link=document.createElement("a");link.href="/home-router.html";link.textContent="NDAHI Home · Home router / Routeur du foyer";section.append(link);
 const target=document.querySelector(".help-link");if(target)target.before(section);else {const main=document.querySelector("main");if(main)main.appendChild(section);}
}).catch(()=>{});
