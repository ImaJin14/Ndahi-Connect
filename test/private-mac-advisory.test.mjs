import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  normalizeMac,
  isRandomizedMac,
  detectClientPlatform,
  currentCaptiveMac,
  isMacAdvisoryDismissed,
  dismissMacAdvisory,
  privateMacGuidance,
  mountPrivateMacAdvisory,
} from "../customer-app/private-mac-advisory.js";
import { sessionStore } from "../customer-app/compat.js";

function clearAdvisoryStorage() {
  sessionStore.remove("ndahi_detected_mac");
  sessionStore.remove("ndahi_private_mac_dismissed");
  sessionStore.remove("ndahi_wifi_hint");
}

test("isRandomizedMac detects locally administered unicast MAC addresses (second hex digit 2, 6, A, E)", () => {
  for (const sample of [
    "02:00:00:00:00:01",
    "12:34:56:78:9A:BC",
    "36:AB:CD:EF:01:23",
    "da:a1:19:45:67:89",
    "FE-ED-FA-CE-00-11",
    "ae:bb:cc:dd:ee:ff",
  ]) {
    assert.equal(isRandomizedMac(sample), true, `expected ${sample} to be recognized as randomized`);
  }

  for (const hardwareOrInvalid of [
    "00:1A:2B:3C:4D:5E",
    "BC:24:11:00:11:22",
    "B8:A3:86:5D:88:39",
    "D4:35:1D:AA:BB:CC",
    "F8:90:E8:12:34:56",
    "01:00:5E:00:00:FB", // multicast
    "FF:FF:FF:FF:FF:FF", // broadcast
    "33:33:00:00:00:01", // IPv6 multicast
    "",
    null,
    "not-a-mac",
    "02:00:00:00:00",
  ]) {
    assert.equal(isRandomizedMac(hardwareOrInvalid), false, `expected ${hardwareOrInvalid} not to be treated as randomized`);
  }
  assert.equal(normalizeMac("da-a1-19-01-02-03"), "DA:A1:19:01:02:03");
});

test("detectClientPlatform and privateMacGuidance prioritize the active mobile OS while showing both iOS and Android toggle hints", () => {
  assert.equal(
    detectClientPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15"),
    "ios",
  );
  assert.equal(
    detectClientPlatform("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/123.0"),
    "android",
  );
  assert.equal(
    detectClientPlatform("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"),
    "other",
  );

  const iosView = privateMacGuidance("da:a1:19:10:20:30", "ios");
  assert.equal(iosView.mac, "DA:A1:19:10:20:30");
  assert.equal(iosView.platforms[0].id, "ios");
  assert.equal(iosView.platforms[0].recommended, true);
  assert.match(iosView.platforms[0].steps, /choose "Fixed" to keep a stable private address/);
  assert.equal(iosView.platforms[0].toggleState, "Fixed / Off");

  const androidView = privateMacGuidance("66:77:88:99:aa:bb", "android");
  assert.equal(androidView.platforms[0].id, "android");
  assert.equal(androidView.platforms[0].recommended, true);
  assert.match(androidView.platforms[0].steps, /Settings → Network → NDAHI Connect → Privacy → "Use device MAC"/);
  assert.equal(androidView.platforms[0].toggleState, "Use device MAC");
});

test("mountPrivateMacAdvisory renders only for randomized MACs and remembers dismissal for the active session including when storage is blocked", (t) => {
  const previousWindow = globalThis.window;
  t.after(() => {
    globalThis.window = previousWindow;
    clearAdvisoryStorage();
  });
  globalThis.window = {
    get sessionStorage() {
      throw new Error("SecurityError: storage disabled");
    },
  };
  clearAdvisoryStorage();

  function fakeContainer() {
    let clickHandler = null;
    return {
      hidden: true,
      innerHTML: "",
      querySelector(selector) {
        if (selector === "[data-dismiss-mac-advisory]" && this.innerHTML.includes("data-dismiss-mac-advisory")) {
          return {
            set onclick(fn) {
              clickHandler = fn;
            },
            get onclick() {
              return clickHandler;
            },
          };
        }
        return null;
      },
      clickDismiss() {
        if (clickHandler) clickHandler();
      },
    };
  }

  const hardwareContainer = fakeContainer();
  const hardwareResult = mountPrivateMacAdvisory({
    container: hardwareContainer,
    search: "?mac=B8:A3:86:5D:88:39&address=10.20.0.12",
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
  });
  assert.equal(hardwareResult.visible, false);
  assert.equal(hardwareContainer.hidden, true);
  assert.equal(hardwareContainer.innerHTML, "");

  const randomContainer = fakeContainer();
  const randomResult = mountPrivateMacAdvisory({
    container: randomContainer,
    search: "?mac=DA:A1:19:22:33:44&address=10.20.0.15",
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
  });
  assert.equal(randomResult.visible, true);
  assert.equal(randomResult.mac, "DA:A1:19:22:33:44");
  assert.equal(randomContainer.hidden, false);
  assert.match(randomContainer.innerHTML, /Possible private Wi-Fi address/);
  assert.match(randomContainer.innerHTML, /choose &quot;Fixed&quot;/);
  assert.match(randomContainer.innerHTML, /&quot;Use device MAC&quot;/);

  // Navigating to /login without query parameters still remembers the detected MAC in the session
  const secondPageContainer = fakeContainer();
  const secondPageResult = mountPrivateMacAdvisory({
    container: secondPageContainer,
    search: "",
    userAgent: "Mozilla/5.0 (Linux; Android 14)",
  });
  assert.equal(secondPageResult.visible, true);
  assert.equal(secondPageContainer.hidden, false);

  // Dismissing hides the banner and suppresses it for the remainder of the session
  secondPageContainer.clickDismiss();
  assert.equal(secondPageContainer.hidden, true);
  assert.equal(isMacAdvisoryDismissed("DA:A1:19:22:33:44"), true);

  const afterDismissContainer = fakeContainer();
  const afterDismissResult = mountPrivateMacAdvisory({
    container: afterDismissContainer,
    search: "?mac=DA:A1:19:22:33:44&address=10.20.0.15",
  });
  assert.equal(afterDismissResult.visible, false);
  assert.equal(afterDismissContainer.hidden, true);

  // Manual dismissal helper also works directly
  clearAdvisoryStorage();
  assert.equal(currentCaptiveMac("?mac=26:11:22:33:44:55"), "26:11:22:33:44:55");
  dismissMacAdvisory("26:11:22:33:44:55");
  assert.equal(isMacAdvisoryDismissed("26:11:22:33:44:55"), true);
});

test("onboarding and login pages wire the private MAC advisory banner", async () => {
  const loginHtml = await readFile(new URL("../customer-app/login.html", import.meta.url), "utf8");
  const onboardingHtml = await readFile(new URL("../customer-app/onboarding.html", import.meta.url), "utf8");
  const loginJs = await readFile(new URL("../customer-app/login.js", import.meta.url), "utf8");
  const onboardingJs = await readFile(new URL("../customer-app/onboarding.js", import.meta.url), "utf8");

  assert.match(loginHtml, /id="privateMacAdvisory"/);
  assert.match(onboardingHtml, /id="privateMacAdvisory"/);
  assert.match(loginJs, /mountPrivateMacAdvisory\(\)/);
  assert.match(onboardingJs, /mountPrivateMacAdvisory\(\)/);
});

