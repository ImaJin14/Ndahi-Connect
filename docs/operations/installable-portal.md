# Installable customer portal

Customers can add the portal to their home screen and open it like an app: full screen, with the NC icon, opening at the dashboard.

## What customers see

Once a customer with an active bundle reaches the dashboard after connecting, an **Install NDAHI Connect** card appears:

| Device | Card |
| --- | --- |
| Android: Chrome, Samsung Internet, Edge | **Install app**. One tap opens the browser's own install dialog. |
| iPhone and iPad | A hint: Share, then **Add to Home Screen**. iPhones only show usage alerts once the app is on the Home Screen. |
| Android Wi-Fi sign-in popup and in-app browsers | A hint to open the portal in Chrome. These browsers cannot install apps. |

The card disappears once the app is installed. **Not now** hides it for 14 days. No browser installs a site without the customer's confirmation.

## Behavior of the installed app

- It is the same portal as in the browser. Customers can sign in and view their balance, expiry, history and receipts from any internet connection. When purchase coverage is enabled, buying, renewing or switching a bundle requires NDAHI Wi-Fi.
- With no connection at all, the service worker (`customer-app/sw.js`) shows a short offline screen with **Try again**. Nothing is cached, so the app always loads the live portal.

## Changing the icons

The icons in `customer-app/assets/icons/` are rendered from the NC brand mark. After a brand change, regenerate them:

```sh
node scripts/generate-app-icons.mjs
```

Set `CHROME_PATH` to a local Chrome if Playwright's own browser isn't installed. The name, colors and start page are in `customer-app/manifest.webmanifest`.
