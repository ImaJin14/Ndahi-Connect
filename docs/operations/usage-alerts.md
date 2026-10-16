# Data-usage alerts

Customers can get a notification on their phone when they reach 50%, 75% and 100% of a bundle's data. Alerts use Web Push and are off until the API has push keys.

## Enable

1. Generate a key pair once and store both values in the password manager:

   ```sh
   npx web-push generate-vapid-keys
   ```

2. On the **API** service in Render, set:

   ```dotenv
   WEB_PUSH_PUBLIC_KEY=<public key>
   WEB_PUSH_PRIVATE_KEY=<private key>
   WEB_PUSH_SUBJECT=mailto:<operations address>
   ```

   `WEB_PUSH_SUBJECT` must be a URI, `mailto:` plus a bare address (for example `mailto:connect@updates.example.com`) or an `https://` contact page. It is not an email `From` value with a display name. Push services may use it to contact you, so prefer an address someone reads. If only some of these are set, or the subject has the wrong form, the pre-deploy environment check fails and says what to fix.

   Redeploy. The portal's **Usage alerts** card appears once these are set. Keep the same keys afterwards. Replacing them invalidates every customer's subscription, and each device then has to turn alerts on again.

## How it works

- The usage sync, every minute by default, records the highest threshold a voucher has newly reached. A jump past several thresholds sends one alert, and each threshold is sent at most once per voucher.
- A worker sends pending alerts every 15 seconds to each device the customer opted in, up to five per customer. A failed push is retried twice with backoff. Devices whose subscription has expired are removed.
- Tapping a notification opens the dashboard.
- Push endpoints are limited to the browser push services (Google, Mozilla, Apple, Microsoft). They are never returned to the portal or to admin record lists.

## Limits

- Customers turn alerts on per device, in a real browser. The Android "Sign in to network" popup can't receive push. On iPhone, the portal must be added to the Home Screen and opened from there (iOS 16.4 or later).
- The device needs internet to receive a push. The 100% alert is sent as the voucher is cut off, so a phone that loses its connection first may only receive it when it next goes online.
- Unlimited bundles have no alerts.
