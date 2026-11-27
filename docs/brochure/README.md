# NDAHI Connect — Connect, Pay & Get Online

Customer quick-start guide, 4 A4 pages, in English and French.

| File | What it is |
| --- | --- |
| `NDAHI-Connect-Pay-Get-Online-EN.pdf` | English edition, A4, print-ready (vector, about 100 KB, so it also goes out on WhatsApp as is) |
| `NDAHI-Connect-Pay-Get-Online-FR.pdf` | French edition, same layout |
| `portal-qr.svg` | QR code for `https://portal.ndahiconnect.net` (decoded and checked) |

**Editable source:** the design canvas boards `Brochure` (one source with an EN/FR switch), `BrochureEN` and `BrochureFR`, copied in `docs/redesign/screens/`. The screenshots inside are the real screen designs with demo data, so they follow the design. Issue: #434.

**State (27 Nov 2026): ready, not released** ([owner](https://github.com/ImaJin14/Ndahi-Connect/issues/434#issuecomment-7228283474)). The PDFs carry the support contact, WhatsApp +237 671 493 902, and no phone line. They go out only once the list below is done.

## Rebuilding the PDFs

```bash
node scripts/brochure-pdf.mjs --whatsapp "+237 671 493 902"            # writes both PDFs here
node scripts/brochure-pdf.mjs --whatsapp "+237 …" --phone "+237 …"     # if a phone line is added later
node scripts/brochure-pdf.mjs --whatsapp "+237 …" --out /tmp/brochure  # a trial copy elsewhere
```

It prints the `Brochure` board in English and French (A4, no margins, backgrounds on) with Chromium, the way the first edition was printed. The board keeps its `[SUPPORT NUMBER]` and `[WHATSAPP NUMBER]` placeholders, and the script fills them in only in the printed copy. It stops if a placeholder is left or a typeface didn't load. It fetches the board's fonts from Google Fonts, so it needs internet. The fonts are embedded as static TrueType faces (DM Sans, Playfair Display), as in the first edition.

## Before public release

Check the guide against the tested portal, then confirm and fill in:

- [x] Support contact: WhatsApp +237 671 493 902 only, no phone line ([owner, 27 Nov](https://github.com/ImaJin14/Ndahi-Connect/issues/434#issuecomment-7228283474)). Filled in by the script above.
- [ ] The Unlimited catalogue is on sale (production still sells the earlier plans), and the guide is checked against the live portal.
- [ ] Official network name, if the guide should name it.
- [ ] The Mobile Money fee: the guide says "plus the Mobile Money fee" until the 2% is verified for MTN and Orange (#432). Then the numeric fee may be added.
- [ ] Short codes for pending prompts (`*126#` MTN, `#150#` Orange): not in the guide until verified for Cameroon.
- [ ] No device-count claim for Home WISP (owner, 24 Nov).
- [ ] Prices match the published catalogue on the day of printing.
- [ ] QR code scanned from the printed page on an Android and an iPhone.
