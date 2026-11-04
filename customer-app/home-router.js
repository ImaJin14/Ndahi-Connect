import { escapeHtml as h } from "/shared/safe-html.js";
import { loadPasskeys, formValues } from "./compat.js";
import { runButton } from "/shared/pending.js";

const api=window.NDAHI_CONFIG.apiUrl,$=q=>document.querySelector(q);
const words={
 en:{back:"Account dashboard",loading:"Checking your Home connection…",disabled:"Home router enrollment is not enabled yet.",title:"One allowance for your home",explain:"All devices behind your WISP router share upload and download data. There is no household device-count limit and no configured household speed cap. Available speed depends on signal, congestion and network capacity.",
 setup:"Set up your WISP router",steps:"In your router's own interface, choose WISP / Hotspot Router (NAT) mode, select NDAHI Connect as upstream Wi-Fi, and set your private home Wi-Fi name and password. Connect this phone through that home Wi-Fi before linking. A printed label MAC may differ from the upstream Wi-Fi identity; you do not need to type either.",
 direct:"Direct-device access",home:"Home router",link:"Link / replace Home router",local:"Continue to local gateway sign-in",confirm:"Confirm household connection",ownership:"I am connected through this household router and want to link it to my account.",name:"Router display name",pin:"Account PIN, or use a passkey below",passkey:"Verify with passkey",assign:"Use bundle for Home",switch:"Switch bundle to direct access",revoke:"Unlink Home router",refresh:"Refresh status",retry:"Retry synchronization",renew:"Renew bundle",buy:"Purchase a bundle",payer:"Mobile Money number",network:"Payment network",pay:"Pay",paid:"Payment confirmed — activation pending. Do not pay again.",pending:"Waiting for router confirmation. Do not pay again.",shared:"Shared remaining data",validity:"Valid until",updated:"Usage last updated",unnamed:"No router linked",stale:"Last recorded usage; current consumption is not confirmed.",select:"Choose a bundle",check:"Check payment",noBundle:"No bundle assigned",receipt:"View payments and receipts",setupNotice:"NDAHI cannot edit your router's private Wi-Fi credentials. Use its own interface.",confirmPrompt:"Finish local gateway sign-in, then confirm below. The temporary sign-in allows only required portal and payment destinations.",confirmed:"Router link confirmed. Choose an eligible bundle or purchase one.",active:"Active",expired:"Expired",exhausted:"Data exhausted",connected:"Router authorization confirmed",activation_pending:"Payment confirmed — activation pending",accounting_review:"Usage reconciliation needs support review; do not pay again.",revoked:"Authorization revoked",error:"The action could not be completed.",chooseMode:"Choose how this bundle connects",history:"Review payment status in your account before starting another payment."},
 fr:{back:"Tableau de bord",loading:"Vérification du routeur…",disabled:"L'inscription NDAHI Home n'est pas encore activée.",title:"Un forfait partagé à la maison",explain:"Tous les appareils derrière le routeur WISP partagent les données envoyées et reçues. Aucune limite du nombre d'appareils du foyer et aucun débit plafonné configuré. Le débit disponible dépend du signal, de la congestion et de la capacité du réseau.",
 setup:"Configurer votre routeur WISP",steps:"Dans l'interface de votre routeur, choisissez WISP / Hotspot Router (NAT), puis NDAHI Connect comme Wi-Fi amont. Configurez le nom et le mot de passe de votre Wi-Fi privé. Connectez ce téléphone à ce Wi-Fi avant l'association. L'adresse MAC de l'étiquette peut différer de celle du Wi-Fi amont : ne saisissez aucune des deux.",
 direct:"Accès direct des appareils",home:"Routeur du foyer",link:"Associer / remplacer le routeur",local:"Continuer vers la connexion locale",confirm:"Confirmer l'association",ownership:"Je suis connecté via ce routeur et souhaite l'associer à mon compte.",name:"Nom du routeur",pin:"Code PIN du compte, ou utilisez une clé d’accès ci-dessous",passkey:"Vérifier avec une clé d'accès",assign:"Utiliser le forfait pour le foyer",switch:"Passer à l'accès direct",revoke:"Dissocier le routeur",refresh:"Actualiser",retry:"Réessayer la synchronisation",renew:"Renouveler le forfait",buy:"Acheter un forfait",payer:"Numéro Mobile Money",network:"Réseau de paiement",pay:"Payer",paid:"Paiement confirmé — activation en attente. Ne payez pas à nouveau.",pending:"Confirmation du routeur en attente. Ne payez pas à nouveau.",shared:"Données restantes partagées",validity:"Valable jusqu'au",updated:"Dernière mesure",unnamed:"Aucun routeur associé",stale:"Dernières données enregistrées ; consommation actuelle non confirmée.",select:"Choisir un forfait",check:"Vérifier le paiement",noBundle:"Aucun forfait associé",receipt:"Paiements et reçus",setupNotice:"NDAHI ne peut pas modifier le Wi-Fi privé du routeur. Utilisez son interface.",confirmPrompt:"Terminez la connexion locale, puis confirmez ci-dessous. Cette connexion temporaire autorise uniquement les destinations du portail et de paiement nécessaires.",confirmed:"Routeur associé. Choisissez un forfait disponible ou achetez-en un.",active:"Actif",expired:"Expiré",exhausted:"Données épuisées",connected:"Autorisation confirmée par le routeur",activation_pending:"Paiement confirmé — activation en attente",accounting_review:"Vérification de consommation requise ; ne payez pas à nouveau.",revoked:"Autorisation révoquée",error:"L'action n'a pas pu être effectuée.",chooseMode:"Choisir le mode d'accès",history:"Vérifiez le paiement dans votre compte avant d'en démarrer un autre."}
};
let language=new URLSearchParams(location.search).get("lang")==="fr"?"fr":"en",csrf="",info,account,paymentId;
const t=key=>words[language][key]||key, post=(path,input)=>call(path,{method:"POST",body:JSON.stringify(input)});
const message=text=>{$("#homeMessage").textContent=text;};
async function call(path,options={}){
 const {allowAnonymous,...requestOptions}=options;
 const response=await fetch(api+path,{credentials:"include",...requestOptions,headers:{"content-type":"application/json",...(csrf?{"x-csrf-token":csrf}:{}),...(options.headers||{})}}),data=await response.json();
 if(response.status===401 && !allowAnonymous && data.code!=="VERIFICATION_FAILED"){location.href="/login";throw Error("Sign in required.");}
 if(!response.ok)throw Object.assign(Error(data.error||t("error")),{status:response.status});return data;
}
const gb=value=>value===null?"∞":Number.isFinite(value)?`${(value/1e9).toLocaleString(language,{maximumFractionDigits:3})} GB`:"—";
const date=value=>value?new Date(value).toLocaleString(language):"—";
function renderStatus(){
 const v=info.bundle,link=info.link;
 $("#homeStatus").setAttribute("aria-busy","false");
 $("#homeStatus").innerHTML=`<h2>${h(t("title"))}</h2><p>${h(t("explain"))}</p><h3>${h(link?.name||t("unnamed"))}</h3>${link?`<p>…${h(link.identifierSuffix)}</p>`:""}<p>${h(t(v?.status||"noBundle"))} · ${h(t(v?.authorization||"pending"))}</p>${v?`<dl><dt>${h(t("shared"))}</dt><dd>${h(gb(v.remainingBytes))}</dd><dt>${h(t("validity"))}</dt><dd>${h(date(v.expiresAt))}</dd><dt>${h(t("updated"))}</dt><dd>${h(date(v.lastUpdatedAt))}</dd></dl>${v.usageState!=="fresh"?`<p role="status">${h(t("stale"))}</p>`:""}`:""}<button type="button" id="refreshHome">${h(t("refresh"))}</button>`;
 $("#refreshHome").onclick=()=>guard(refresh);
}
function render(){
 document.documentElement.lang=language;$("#back").textContent=t("back");
 const v=info.bundle,link=info.link;
 renderStatus();
 $("#homeSetup").innerHTML=`<h2>${h(t("setup"))}</h2><p>${h(t("steps"))}</p><p>${h(t("setupNotice"))}</p><p><a href="/dashboard#payments">${h(t("receipt"))}</a></p>`;
 if(!info.enabled){$("#homeActions").textContent=t("disabled");return;}
 const enrollmentId=new URLSearchParams(location.search).get("enrollment");
 $("#homeActions").innerHTML=`<h2>${h(t("chooseMode"))}</h2><p>${h(t(info.accessMode==="home"?"home":"direct"))}</p><button type="button" id="enrollHome">${h(t("link"))}</button><div id="enrollmentForm"></div>${enrollmentId?`<form id="confirmHome"><p>${h(t("confirmPrompt"))}</p><label>${h(t("name"))}<input name="name" maxlength="80" value="${h(link?.name||"Home router")}"></label><label><input type="checkbox" name="confirm" required>${h(t("ownership"))}</label><button>${h(t("confirm"))}</button>${window.PublicKeyCredential?`<button type="button" data-home-passkey="confirm">${h(t("passkey"))}</button>`:""}</form>`:""}<label>${h(t("pin"))}<input id="homePin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="current-password"></label>${v?.eligible?`<button type="button" id="modeHome" ${!link||info.accessMode==="home"&&!v.assignmentRequired||v.transition?"disabled":""}>${h(t("assign"))}</button><button type="button" id="modeDirect" ${info.accessMode!=="home"||v.transition?"disabled":""}>${h(t("switch"))}</button>`:""}${window.PublicKeyCredential&&v?.eligible?`<button type="button" data-home-passkey="mode">${h(t("passkey"))} · ${h(t(info.accessMode==="home"&&!v.assignmentRequired?"switch":"assign"))}</button>`:""}${link?`<button type="button" id="revokeHome">${h(t("revoke"))}</button>${window.PublicKeyCredential?`<button type="button" id="revokeHomePasskey" data-home-passkey="revoke">${h(t("passkey"))} · ${h(t("revoke"))}</button>`:""}`:""}<div>${info.operations.map(o=>`<p role="status">${h(t(o.code==="HOME_ACCOUNTING_REVIEW"?"accounting_review":"pending"))}</p>${["retry","needs_review"].includes(o.status)?`<button type="button" data-home-retry="${h(o.id)}">${h(t("retry"))}</button>`:""}`).join("")}</div>${link&&!v?.eligible?`<form id="homePurchase"><h3>${h(t(v?"renew":"buy"))}</h3><label>${h(t("select"))}<select name="planId">${info.plans.map(p=>`<option value="${h(p.id)}">${h(p.name)} · ${h(p.price)} FCFA · ${h(gb(p.quotaGb===null?null:p.quotaGb*1e9))}</option>`).join("")}</select></label><label>${h(t("payer"))}<input name="payerPhone" value="${h(account.customer.phone||"")}" inputmode="tel" required></label><label>${h(t("network"))}<select name="network"><option value="mtn">MTN Mobile Money</option><option value="orange">Orange Money</option></select></label><button>${h(t("pay"))}</button></form>`:""}${paymentId?`<button type="button" id="checkHomePayment">${h(t("check"))}</button><p>${h(t("history"))}</p>`:""}`;
 $("#refreshHome").onclick=()=>guard(refresh);
 $("#enrollHome").onclick=e=>runButton(e.currentTarget,t("pending"),()=>guard(async()=>{
   const enrollment=await post("/api/account/home/enroll",{}),expected=window.NDAHI_CONFIG.hotspotLoginUrl;
   if(!expected || enrollment.login.url!==expected)throw Error("The local gateway login URL needs operator configuration.");
   const form=document.createElement("form");form.method="post";form.action=expected;
   for(const [name,value] of Object.entries({username:enrollment.login.username,password:enrollment.login.password,dst:new URL(`/home-router.html?enrollment=${encodeURIComponent(enrollment.enrollmentId)}&lang=${language}`,location.origin).href,popup:"false"})){
     const input=document.createElement("input");input.type="hidden";input.name=name;input.value=value;form.append(input);
   }
   const submit=document.createElement("button");submit.textContent=t("local");form.append(submit);$("#enrollmentForm").textContent="";$("#enrollmentForm").appendChild(form);
 }));
 const pin=()=>$("#homePin").value;
 async function prove(action,input,passkey){
   const payload={action,...input};
   if(passkey){const proof=await post("/api/account/home/options",payload);payload.response=await (await loadPasskeys()).startAuthentication({optionsJSON:proof.options});payload.challengeId=proof.challengeId;}
   else payload.pin=pin();
   await post(`/api/account/home/${action}`,payload);message(t(action==="confirm"?"confirmed":"pending"));
   if(action==="confirm"){const url=new URL(location.href);url.searchParams.delete("enrollment");history.replaceState(null,"",url);}
   await refresh();
 }
 const confirm=$("#confirmHome");
 if(confirm)confirm.onsubmit=e=>{e.preventDefault();runButton(e.submitter,t("pending"),()=>guard(()=>prove("confirm",{enrollmentId,name:confirm.elements.name.value,confirm:confirm.elements.confirm.checked},false)));};
 const bind=(id,action,input)=>{const el=$(id);if(el)el.onclick=e=>runButton(e.currentTarget,t("pending"),()=>guard(()=>prove(action,input,false)));};
 bind("#modeHome","mode",{voucherId:v?.id,mode:"home"});bind("#modeDirect","mode",{voucherId:v?.id,mode:"direct"});bind("#revokeHome","revoke",{});
 document.querySelectorAll("[data-home-passkey]").forEach(button=>button.onclick=()=>guard(()=>button.dataset.homePasskey==="confirm"?prove("confirm",{enrollmentId,name:confirm.elements.name.value,confirm:confirm.elements.confirm.checked},true):button.dataset.homePasskey==="revoke"?prove("revoke",{},true):prove("mode",{voucherId:v.id,mode:info.accessMode==="home"&&!v.assignmentRequired?"direct":"home"},true)));
 document.querySelectorAll("[data-home-retry]").forEach(button=>button.onclick=()=>guard(async()=>{await post("/api/account/home/retry",{operationId:button.dataset.homeRetry});await refresh();}));
 const purchase=$("#homePurchase");if(purchase)purchase.onsubmit=e=>{e.preventDefault();runButton(e.submitter,t("pending"),()=>guard(async()=>{
   const input=formValues(purchase),key=Array.from(crypto.getRandomValues(new Uint8Array(24)),n=>n.toString(16).padStart(2,"0")).join("");
   const result=await post("/api/account/plan/purchase",{...input,accessMode:"home",action:v?.planId===input.planId?"renew":"switch",requestKey:key});
   paymentId=result.payment.id;try{sessionStorage.setItem("ndahi-home-payment",paymentId);}catch{}
   if(result.checkout?.url){const url=new URL(result.checkout.url);if(url.protocol!=="https:")throw Error("Payment URL is unavailable.");location.assign(url.href);return;}
   message(t("pending"));render();
 }));};
 const check=$("#checkHomePayment");if(check)check.onclick=()=>guard(async()=>{const result=await call(`/api/account/payments/${encodeURIComponent(paymentId)}/status`);message(result.payment.status==="paid"?t("paid"):t("pending"));await refresh();});
}
async function refresh(){info=await call("/api/account/home");render();if(info.bundle?.authorization==="connected")message("");}
async function guard(fn){try{await fn();}catch(error){message(error.message||t("error"));}}
document.querySelectorAll("[data-language]").forEach(b=>b.onclick=()=>{language=b.dataset.language;message("");if(info)render();else guard(registration);});
message(t("loading"));
async function boot(){
 try{account=await call("/api/account/dashboard",{allowAnonymous:true});csrf=account.csrfToken;try{paymentId=sessionStorage.getItem("ndahi-home-payment");}catch{}await refresh();message("");}
 catch(error){if(error.status===401)await registration();else message(error.message);}
}
async function registration(){
 const config=await call("/api/home/config",{allowAnonymous:true});
 $("#homeStatus").setAttribute("aria-busy","false");
 if(!config.enabled){$("#homeStatus").textContent=t("disabled");return;}
 const fr=language==="fr";
 $("#homeStatus").innerHTML=`<h2>${fr?"Créer un compte pour NDAHI Home":"Create an account for NDAHI Home"}</h2><p><a href="/login">${fr?"Compte existant : se connecter":"Existing account: sign in"}</a></p><form id="homeRegister"><label>${fr?"Nom":"Name"}<input name="name" maxlength="100" autocomplete="name"></label><label>${fr?"Numéro de compte (Cameroun)":"Account number (Cameroon)"}<input name="phone" inputmode="tel" autocomplete="tel" required></label><label>PIN<input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="new-password" required></label><label>${fr?"Confirmer le PIN":"Confirm PIN"}<input name="confirmPin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="new-password" required></label><button>${fr?"Créer un compte":"Create account"}</button></form><p>${fr?"Cette inscription ne vérifie pas la propriété du numéro de téléphone.":"Registration does not verify ownership of the phone number."}</p>`;
 $("#homeActions").textContent=t("steps");$("#homeSetup").textContent=t("explain");message("");
 $("#homeRegister").onsubmit=e=>{e.preventDefault();runButton(e.submitter,t("pending"),()=>guard(async()=>{await post("/api/account/home/register",formValues(e.target));await boot();}));};
}
void guard(boot);
// Keep unfinished forms stable: refresh is explicit, and polling updates status
// text only. Never rerender a PIN/payment form while the customer is typing.
setInterval(()=>{if(document.hidden||!info||document.activeElement?.matches("input,select"))return;call("/api/account/home").then(next=>{info=next;const v=next.bundle;if(v)renderStatus();}).catch(()=>{});},15000);
