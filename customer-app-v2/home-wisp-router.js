// Home WISP router (#351, canvas PhoneHomeRouter; owner 27 Nov: extend the Home
// API). For a Home WISP Unlimited bundle: register the home router (three
// steps), "Router found" with its masked upstream address and where it was seen
// (read from the router, never from the browser), then the status card, Online
// or "Sharing is paused" while the entitlement can't be confirmed. Registering
// and replacing use the existing Home enrollment and confirm: a local sign-in
// through the router, then the PIN. No device or router count anywhere.
import { escapeHtml as h } from "/shared/safe-html.js";
import { format } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";
import { runButton } from "/shared/pending.js";

const L = (key, values) => format(key, values || {}, currentLanguage());
const locale = () => currentLanguage() === "fr" ? "fr-FR" : "en-GB";
const BACK = '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18 9 12l6-6"></path></svg>';
// "22 Dec" and "Tue 22 Dec · 18:03"
const shortDay = (iso) => new Date(iso).toLocaleDateString(locale(), { day: "numeric", month: "short" }).replace(/\.$/, "");
const longDay = (iso) => { const d = new Date(iso); return d.toLocaleDateString(locale(), { weekday: "short", day: "numeric", month: "short" }).replace(/,/g, "").replace(/\.(?= |$)/g, "") + " · " + d.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" }); };
// "Seen just now" / "Seen 2 min ago"; "just now" / "2 min ago" for the last try.
function ago(iso, kind) {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return minutes < 1 ? L(kind + "JustNow") : minutes < 60 ? L(kind + "Minutes", { count: minutes }) : L(kind + "Hours", { count: Math.round(minutes / 60) });
}
const masked = (tail) => "••:••:••:" + tail;

export function mountHomeWisp(root, { info, post, refresh, loginUrl }) {
  const params = new URLSearchParams(location.search), enrollmentId = params.get("enrollment");
  const wisp = info.homeWisp, link = info.link;
  let step = link && wisp.sharing ? "on" : enrollmentId ? "found" : "setup", replacing = false, found = null, note = "";
  document.body.setAttribute("data-home-wisp", "");
  const clearEnrollment = () => { const url = new URL(location.href); url.searchParams.delete("enrollment"); history.replaceState(null, "", url); };

  // The existing enrollment: a one-use local sign-in through the router, which
  // comes back here with its id; the router then shows as found.
  async function findRouter(button) {
    await runButton(button, L("homeWispFinding"), async () => {
      try {
        const enrollment = await post("/api/account/home/enroll", {});
        if (!loginUrl || enrollment.login.url !== loginUrl) throw Error(L("homeWispNotReady"));
        const form = document.createElement("form");
        form.method = "post"; form.action = loginUrl; form.hidden = true;
        for (const [name, value] of Object.entries({ username: enrollment.login.username, password: enrollment.login.password,
          dst: new URL("/home-router.html?enrollment=" + encodeURIComponent(enrollment.enrollmentId), location.origin).href, popup: "false" })) {
          const input = document.createElement("input"); input.type = "hidden"; input.name = name; input.value = value; form.append(input);
        }
        document.body.append(form);
        HTMLFormElement.prototype.submit.call(form);
      } catch (error) { note = error.message || L("homeWispNotReady"); render(); }
    });
  }
  async function detect() {
    try { found = (await post("/api/account/home/detect", { enrollmentId })).router; }
    catch (error) { clearEnrollment(); step = "setup"; note = error.message || L("homeWispNotFound"); }
    render();
  }
  async function register(button) {
    const pin = root.querySelector("#homeWispPin").value;
    await runButton(button, L("homeWispRegistering"), async () => {
      try {
        await post("/api/account/home/confirm", { action: "confirm", enrollmentId, confirm: true, name: "Home router", pin });
        clearEnrollment();
        await refresh();
      } catch (error) { note = error.message; render(); }
    });
  }

  function bar() {
    return `<div class="home-wisp__bar"><a class="home-wisp__back" href="/dashboard#account" aria-label="${h(L("homeWispBack"))}">${BACK}</a><span class="home-wisp__name">${h(L("homeWispTitle"))}</span>${wisp.expiresAt ? `<span class="home-wisp__ends">${h(L("homeWispEnds", { date: shortDay(wisp.expiresAt) }))}</span>` : ""}</div>`;
  }
  const status = () => note ? `<p class="home-wisp__note" role="alert">${h(note)}</p>` : "";
  function render() {
    let main = "", foot = "";
    if (step === "setup") {
      main = `<h1 class="home-wisp__h1">${h(L("homeWispSetupTitle"))}</h1><p class="home-wisp__lede">${h(L("homeWispSetupLede"))}</p>
        <ol class="home-wisp__steps"><li><span class="home-wisp__n" aria-hidden="true">1</span><span>${L("homeWispStep1", { network: "<strong>NDAHI</strong>" })} <a href="/help.html#home-router">${h(L("homeWispHow"))}</a></span></li>
        <li><span class="home-wisp__n" aria-hidden="true">2</span><span>${L("homeWispStep2", { router: `<strong>${h(L("homeWispYourRouter"))}</strong>` })}</span></li>
        <li><span class="home-wisp__n" aria-hidden="true">3</span><span>${L("homeWispStep3", { portal: "<strong>portal.ndahiconnect.net</strong>" })}</span></li></ol>
        <p class="home-wisp__tip">${h(L("homeWispShareNote"))}</p>${status()}`;
      foot = `<button type="button" class="home-wisp__btn" data-home-find>${h(L("homeWispFind"))}</button>`;
    } else if (step === "found") {
      main = `<h1 class="home-wisp__h1">${h(L(found ? "homeWispFoundTitle" : "homeWispLooking"))}</h1>` + (found ? `
        <section class="home-wisp__found" aria-label="${h(L("homeWispDetected"))}"><strong>${h(L("homeWispReaching"))}</strong><span class="home-wisp__mono">${h(L("homeWispUpstream", { address: masked(found.identifierTail) }))}</span><span class="home-wisp__seen">${h([ago(found.seenAt, "homeWispSeen"), found.place].filter(Boolean).join(" · "))}</span></section>
        <p class="home-wisp__lede">${h(L("homeWispRegisterAsk"))}</p>
        <div><label class="home-wisp__label" for="homeWispPin">${h(L("homeWispPinLabel"))}</label><input class="home-wisp__pin" id="homeWispPin" type="password" inputmode="numeric" pattern="[0-9]{4,6}" maxlength="6" autocomplete="current-password"></div>` : "") + status();
      foot = found ? `<button type="button" class="home-wisp__btn" data-home-register>${h(L("homeWispRegister"))}</button><button type="button" class="home-wisp__btn2" data-home-not-mine>${h(L("homeWispNotMine"))}</button>` : "";
    } else {
      const paused = wisp.sharing === "paused";
      main = `<section class="home-wisp__status${paused ? " home-wisp__status--paused" : ""}" aria-label="${h(L("homeWispStatus"))}"><div class="home-wisp__status-top"><p class="home-wisp__kicker">${h(L("homeWispRegistered"))}</p><span class="home-wisp__pill">${h(L(paused ? "homeWispChecking" : "homeWispOnline"))}</span></div>
        <p class="home-wisp__status-title">${h(L(paused ? "homeWispPaused" : "homeWispSharing"))}</p>
        <div class="home-wisp__row"><span>${h(L("homeWispRouter"))}</span><span class="home-wisp__mono">••:${h(link.identifierTail)}</span></div>
        <div class="home-wisp__row"><span>${h(L("homeWispSubscription"))}</span><span>${wisp.expiresAt ? h(L("homeWispEndsLong", { when: longDay(wisp.expiresAt) })) : ""}</span></div></section>`
        + (paused ? `<p class="home-wisp__alert" role="alert"><strong>${h(L("homeWispPausedLead"))}</strong> ${h(L("homeWispPausedBody"))} ${h(wisp.lastTryAt ? L("homeWispRetrying", { ago: ago(wisp.lastTryAt, "homeWispAgo") }) : L("homeWispRetryingSoon"))} ${h(L("homeWispNoPay"))}</p>` : "")
        + (replacing ? `<p class="home-wisp__tip">${h(L("homeWispReplaceNote"))}</p>` : "")
        + `<p class="home-wisp__small">${h(L("homeWispOnlyThis"))}</p>${status()}`;
      // Replacing (not drawn, owner to confirm): the same find step, from the new router.
      foot = (replacing ? `<button type="button" class="home-wisp__btn" data-home-find>${h(L("homeWispFind"))}</button>` : "")
        + `<button type="button" class="home-wisp__btn2" data-home-replace aria-expanded="${replacing}">${h(L(replacing ? "homeWispKeep" : "homeWispReplace"))}</button><a class="home-wisp__btn2" href="/help.html">${h(L("homeWispHelp"))}</a>`;
    }
    root.innerHTML = `<div class="home-wisp">${bar()}<div class="home-wisp__main">${main}</div>${foot ? `<div class="home-wisp__foot">${foot}</div>` : ""}</div>`;
    root.querySelector("[data-home-find]")?.addEventListener("click", (event) => { note = ""; void findRouter(event.currentTarget); });
    root.querySelector("[data-home-register]")?.addEventListener("click", (event) => { note = ""; void register(event.currentTarget); });
    root.querySelector("[data-home-not-mine]")?.addEventListener("click", () => { clearEnrollment(); step = link && wisp.sharing ? "on" : "setup"; found = null; note = ""; render(); });
    root.querySelector("[data-home-replace]")?.addEventListener("click", () => { replacing = !replacing; render(); });
  }
  render();
  if (step === "found") void detect();
}
