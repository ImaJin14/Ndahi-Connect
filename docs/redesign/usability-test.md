# Usability test — before ramping past 10%

Run this before raising `UI_V2_PERCENT` above 10 (Phase 7). One afternoon, five people, one facilitator and one note-taker.

## Who

Five real or likely customers, not staff:

- at least three on low-end Android phones (2–3 GB RAM, Go edition if possible);
- at least two who usually use the app in French;
- at least one who has never used NDAHI before;
- at least one who uses Orange Money, not MTN.

Give each a small bundle as thanks.

## Setup

- On site, joined to NDAHI Wi-Fi, with the phone's own browser.
- Force the new design with `?ui=new`.
- Use real bundles on staging or a test plan with a real small amount, so the Mobile Money approval is real.
- Don't help. If someone is stuck for more than a minute, note it, then help and move on.

## Tasks

Read each task aloud. Don't use the words on the buttons.

1. "You've just arrived and want internet for the week. Get online." *(hotspot → sign up → buy → connected)*
2. "Your friend gave you this card." Hand over a printed voucher slip. *(scan or type → connected)*
3. "How much internet do you have left, and when does it end?"
4. "Your bundle ended. Get the same one again." *(renewal button)*
5. "Your cousin's phone needs internet. Pay for it from your phone." *(buy for someone else)*
6. "Add your laptop to your bundle." *(devices / pairing)*
7. "You forgot your PIN. Get back in." *(email reset)*
8. "Find a router you could buy and see where to collect it." *(Shop tab)*

For task 1, ask one participant to decline the Mobile Money prompt on purpose. Watch whether the failure screen makes the next step clear.

## What to note per task

| | Done? (yes / with help / no) | Time | Where they hesitated | What they said |
| --- | --- | --- | --- | --- |

## Pass bar to ramp past 10%

- Tasks 1, 2 and 4: at least 4 of 5 people finish without help.
- Nobody pays twice, or believes they did.
- No one is stuck on a French label.

Fix anything that fails the bar, re-test with two new people, then ramp.
