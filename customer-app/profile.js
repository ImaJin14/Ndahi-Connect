import { formValues, requestJson, loadPasskeys } from "./compat.js";
import {normalizeCameroonPhone,validCameroonPhone,suggestedPaymentNetwork} from "/shared/cameroon-phone.js";
import { showError } from "./errors.js";
import { runButton } from "/shared/pending.js";

const lostResponse = (error) => ["TypeError", "TimeoutError", "SyntaxError"].includes(error.name);

export function mountEmailLink({ call, customer, onChanged }) {
  const form = document.getElementById("linkEmail"), confirm = document.getElementById("confirmEmail"),
    passkey = document.getElementById("linkEmailPasskey");
  if (passkey && (!window.PublicKeyCredential || !navigator.credentials)) passkey.hidden = true;
  async function request(usePasskey) {
    const input = formValues(form), message = document.getElementById("emailLinkMessage");
    if (!form.elements.email.reportValidity()) return;
    try {
      await runButton(usePasskey ? passkey : form.querySelector('[type="submit"]'), "Verifying…", async () => {
        message.textContent = "";
        let payload = { email: input.email, pin: input.pin };
        if (usePasskey) {
          const browser = await loadPasskeys();
          const challenge = await call("/api/account/profile/email/options", { method: "POST", body: JSON.stringify({ email: input.email }) });
          payload = { email: input.email, challengeId: challenge.challengeId,
            response: await browser.startAuthentication({ optionsJSON: challenge.options }) };
        }
        try { await call("/api/account/profile/email", { method: "POST", body: JSON.stringify(payload) }); }
        catch (error) {
          if (!lostResponse(error)) throw error;
          const dashboard = await call("/api/account/dashboard");
          if (dashboard.customer.pendingEmail?.email !== input.email.trim().toLowerCase()) throw error;
        }
        form.reset();
        await onChanged(false);
      }, { controls: Array.from(form.elements) });
    } catch (error) { showError(message, error); }
  }
  if (form) form.onsubmit = (event) => { event.preventDefault(); void request(false); };
  if (passkey) passkey.onclick = () => { void request(true); };
  if (confirm) confirm.onsubmit = async (event) => {
    event.preventDefault();
    const input = formValues(confirm), message = document.getElementById("emailConfirmMessage");
    try {
      await runButton(confirm.querySelector('[type="submit"]'), "Confirming…", async () => {
        message.textContent = "";
        try { await call("/api/account/profile/email/confirm", { method: "POST", body: JSON.stringify(input) }); }
        catch (error) {
          if (!lostResponse(error)) throw error;
          const recovered = await requestJson(window.NDAHI_CONFIG.apiUrl + "/api/account/dashboard", { credentials: "include", cache: "no-store" });
          if (!recovered.response.ok || !recovered.body.customer?.emailLinked || recovered.body.customer.email !== customer.pendingEmail?.email) throw error;
        }
        confirm.reset();
        await onChanged(true);
      }, { controls: Array.from(confirm.elements) });
    } catch (error) { showError(message, error); }
  };
}

export function mountProfileEdit({call,customer,onChanged}) {
  const form=document.getElementById("profileEdit"),passkey=document.getElementById("profileEditPasskey"),cancel=document.getElementById("cancelProfileConfirmation");
  const message=document.getElementById("profileEditMessage");
  if(!form)return;
  if(passkey&&(!window.PublicKeyCredential||!navigator.credentials))passkey.hidden=true;
  let operationId,signature;
  function sensitive(){return normalizeCameroonPhone(form.elements.phone.value)!==normalizeCameroonPhone(customer.phone)||form.elements.email.value.trim().toLowerCase()!==(customer.email||"").toLowerCase()||Boolean(form.elements.verifyEmail?.checked);}
  function update(){
    const number=form.elements.phone.value,provider=suggestedPaymentNetwork(number);
    document.getElementById("profilePhoneProvider").textContent=provider ? "Likely provider: "+(provider==="mtn"?"MTN Mobile Money":"Orange Money") : validCameroonPhone(number) ? "Provider could not be suggested. You can select it at checkout." : "Enter a valid Cameroon number.";
    const removing=Boolean(customer.email&&!form.elements.email.value.trim());
    document.getElementById("profileEmailRemoval").hidden=!removing;form.elements.removeEmail.required=removing;
    form.elements.pin.required=sensitive()&&customer.pinConfigured!==false;
  }
  form.oninput=update;update();
  async function save(usePasskey){
    const input=formValues(form);input.verifyEmail=Boolean(form.elements.verifyEmail?.checked);input.removeEmail=form.elements.removeEmail.checked;
    if(!form.elements.name.reportValidity()||!form.elements.phone.reportValidity()||!form.elements.email.reportValidity()||!form.elements.removeEmail.reportValidity())return;
    if(!usePasskey&&!form.elements.pin.reportValidity())return;
    const target=JSON.stringify([input.name,input.phone,input.email,input.verifyEmail,input.removeEmail]);
    if(target!==signature){signature=target;const bytes=crypto.getRandomValues(new Uint8Array(16));operationId=Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");}
    input.operationId=operationId;input.expectedVersion=customer.profileVersion;
    try{await runButton(usePasskey?passkey:form.querySelector('[type="submit"]'),"Saving…",async()=>{
      message.textContent="";
      if(usePasskey&&sensitive()){
        const browser=await loadPasskeys(),challenge=await call("/api/account/profile/options",{method:"POST",body:JSON.stringify(input)});
        input.challengeId=challenge.challengeId;input.response=await browser.startAuthentication({optionsJSON:challenge.options});delete input.pin;
      }
      let result;
      try{result=await call("/api/account/profile",{method:"POST",body:JSON.stringify(input)});}
      catch(error){
        if(!lostResponse(error))throw error;
        const recovered=await call("/api/account/dashboard");
        if(recovered.customer.pendingProfile?.operationId===operationId)result={verificationPending:true};
        else if(recovered.customer.name===input.name.trim().replace(/\s+/g," ")&&normalizeCameroonPhone(recovered.customer.phone)===normalizeCameroonPhone(input.phone)&&(recovered.customer.email||"")===input.email.trim().toLowerCase())result={profileSaved:true};
        else throw error;
      }
      await onChanged(result.verificationPending===true);
    },{controls:Array.from(form.elements)});}catch(error){showError(message,error);}
  }
  form.onsubmit=event=>{event.preventDefault();void save(false);};if(passkey)passkey.onclick=()=>void save(true);
  if(cancel)cancel.onclick=async()=>{try{await runButton(cancel,"Cancelling…",async()=>{await call("/api/account/profile",{method:"POST",body:JSON.stringify({action:"cancel"})});await onChanged(false);document.getElementById("dashboardMessage").textContent="Pending profile changes cancelled.";});}catch(error){showError(document.getElementById("emailConfirmMessage"),error);}};
}
