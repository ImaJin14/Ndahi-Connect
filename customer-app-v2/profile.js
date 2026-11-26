import { formValues, requestJson, loadPasskeys } from "./compat.js";
import { format } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";
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

// Edit profile (canvas: PhoneEditProfile, #398; owner 26 Nov): name and email
// only; the sign-in number is read-only. When the email changes, "Save changes"
// asks for the PIN (or a passkey) in a dialog and the new address gets a link.
export function mountProfileEdit({call,customer,onChanged}) {
  const form=document.getElementById("profileEdit"),cancel=document.getElementById("cancelProfileConfirmation");
  const message=document.getElementById("profileEditMessage"),dialog=document.getElementById("profilePinDialog");
  if(!form)return;
  const pinForm=document.getElementById("profilePinForm"),passkey=document.getElementById("profileEditPasskey");
  const pinMessage=document.getElementById("profilePinMessage");
  if(passkey&&(!window.PublicKeyCredential||!navigator.credentials))passkey.hidden=true;
  const L=(key,values)=>format(key,values||{},currentLanguage());
  let operationId,signature,opener;
  const email=()=>form.elements.email.value.trim().toLowerCase();
  const removing=()=>Boolean(customer.email&&!email());
  // Only an email change needs the PIN; a name change saves at once.
  const sensitive=()=>email()!==(customer.email||"").toLowerCase()||Boolean(form.elements.verifyEmail?.checked);
  function update(){
    document.getElementById("profileEmailRemoval").hidden=!removing();form.elements.removeEmail.required=removing();
    if(!removing())form.elements.removeEmail.checked=false;
  }
  form.oninput=update;update();
  function values(){
    const input={name:form.elements.name.value,phone:customer.phone,email:form.elements.email.value,
      verifyEmail:Boolean(form.elements.verifyEmail?.checked),removeEmail:form.elements.removeEmail.checked};
    if(email()&&sensitive())input.confirmBy="link";
    const target=JSON.stringify([input.name,input.email,input.verifyEmail,input.removeEmail]);
    if(target!==signature){signature=target;const bytes=crypto.getRandomValues(new Uint8Array(16));operationId=Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");}
    return {...input,operationId,expectedVersion:customer.profileVersion};
  }
  function valid(){
    message.textContent="";
    if(!form.elements.name.value.trim()){message.textContent=L("profileNameNeeded");form.elements.name.focus();return false;}
    if(email()&&!form.elements.email.checkValidity()){message.textContent=L("profileEmailInvalid");form.elements.email.focus();return false;}
    if(removing()&&!form.elements.removeEmail.checked){form.elements.removeEmail.focus();form.elements.removeEmail.reportValidity();return false;}
    return true;
  }
  async function save(input,button,{proof=null,controls=Array.from(form.elements),output=message}={}){
    await runButton(button,"Saving…",async()=>{
      output.textContent="";
      if(proof==="passkey"){
        const browser=await loadPasskeys(),challenge=await call("/api/account/profile/options",{method:"POST",body:JSON.stringify(input)});
        input.challengeId=challenge.challengeId;input.response=await browser.startAuthentication({optionsJSON:challenge.options});delete input.pin;
      }
      let result;
      try{result=await call("/api/account/profile",{method:"POST",body:JSON.stringify(input)});}
      catch(error){
        if(!lostResponse(error))throw error;
        const recovered=await call("/api/account/dashboard");
        if(recovered.customer.pendingProfile?.operationId===operationId)result={verificationPending:true};
        else if(recovered.customer.name===input.name.trim().replace(/\s+/g," ")&&(recovered.customer.email||"")===input.email.trim().toLowerCase())result={profileSaved:true};
        else throw error;
      }
      if(dialog?.open)dialog.close();
      await onChanged(result.verificationPending===true);
    },{controls});
  }
  form.onsubmit=async event=>{
    event.preventDefault();
    if(!valid())return;
    const input=values();
    if(sensitive()||removing()){
      if(customer.pinConfigured!==false&&dialog){
        opener=form.querySelector('[type="submit"]');
        document.getElementById("profilePinLede").textContent=removing()?L("profilePinRemoveEmail"):L(email()===(customer.email||"").toLowerCase()?"profilePinVerifyEmail":"profilePinNewEmail",{email:email()});
        pinForm.reset();pinMessage.textContent="";
        dialog.showModal();pinForm.elements.pin.focus();
        return;
      }
    }
    try{await save(input,form.querySelector('[type="submit"]'));}catch(error){showError(message,error);}
  };
  if(pinForm)pinForm.onsubmit=async event=>{
    event.preventDefault();
    if(!/^[0-9]{4,6}$/.test(pinForm.elements.pin.value)){pinMessage.textContent=L("profilePinNeeded");pinForm.elements.pin.focus();return;}
    try{await save({...values(),pin:pinForm.elements.pin.value},pinForm.querySelector('[type="submit"]'),{controls:Array.from(pinForm.elements),output:pinMessage});}
    catch(error){showError(pinMessage,error);}
    finally{pinForm.elements.pin.value="";}
  };
  if(passkey)passkey.onclick=async()=>{try{await save(values(),passkey,{proof:"passkey",controls:Array.from(pinForm.elements),output:pinMessage});}catch(error){showError(pinMessage,error);}};
  if(dialog){
    document.getElementById("profilePinCancel").onclick=()=>dialog.close();
    dialog.onclose=()=>{pinForm.elements.pin.value="";if(opener?.isConnected)opener.focus();};
  }
  if(cancel)cancel.onclick=async()=>{try{await runButton(cancel,"Cancelling…",async()=>{await call("/api/account/profile",{method:"POST",body:JSON.stringify({action:"cancel"})});await onChanged(false);document.getElementById("dashboardMessage").textContent="Pending profile changes cancelled.";});}catch(error){showError(document.getElementById("emailConfirmMessage"),error);}};
}
