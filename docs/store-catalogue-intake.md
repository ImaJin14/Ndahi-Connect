# Requested device catalogue — 8 November 2026

The owner requested these four entries, totalling **22 units**:

| Product as supplied | Quantity | Confirmation needed |
| --- | ---: | --- |
| TP-Link AX1500 travel router | 10 | Exact model code, hardware version and price |
| TP-Link CPE210 | 6 | Price and hardware version |
| Wavlink AC1200 | 2 | Exact WL/WS model code and price |
| Wavlink Mini | 4 | Exact WL/WS model code and price |

The structured [catalogue intake](store-catalogue-intake.json) records quantities, official source references and draft EN/FR copy. The owner subsequently approved immediate live publication, with prices and exact model details to be updated later. Publication is being deployed as four **published, unpriced listings**. Missing prices remain null and display “Price to be confirmed”; no fake selling price is used. New checkout requests for unpriced products are rejected by the API.

## Official documentation checked

- [TP-Link TL-WR1502X](https://www.tp-link.com/us/home-networking/wifi-router/tl-wr1502x/): a plausible AX1500 travel-router match, not yet confirmed as the owner's unit. Its description is explicitly conditional in the intake.
- [TP-Link CPE210](https://www.tp-link.com/eg/business-networking/pharos-cpe/cpe210/) and [official model/revision support](https://support.omadanetworks.com/en/product/cpe210/): matched model. Copy omits revision-sensitive Ethernet port counts and unverified package contents. The regional page marks the product End of Life; verify local support and the supplied hardware revision rather than promise ongoing updates.
- Wavlink's [AC1200 catalogue results](https://www.wavlink.com/en_us/search?key=ac1200&page=1&type=product) include multiple indoor/outdoor products with different ports and operating modes. Candidate pages are recorded, but none is selected as the owner's unit.
- Wavlink [WN525N2 Mini](https://www.wavlink.com/en_us/product/WL-WN525N2.html) and [WN519N2 Mini](https://www.wavlink.com/en_us/product/WL-WN519N2) demonstrate why “Mini” does not identify a unique device. No specifications are assigned until the label code is confirmed.

Descriptions are short original paraphrases of manufacturer facts, not copied marketing text. Advertised wireless rates do not guarantee internet speed. No physical compatibility test, local warranty, included voucher or accessory inventory is asserted.

## Update the live listings later

1. Confirm model codes, hardware versions and selling prices; use the matching official regional/revision documentation to finish the copy.
2. In **Admin → Store → Products**, edit the existing SKUs `ND-TPLINK-AX1500`, `ND-TPLINK-CPE210`, `ND-WAVLINK-AC1200` and `ND-WAVLINK-MINI`. Do not create duplicate products.
3. Enter a positive whole-FCFA price when confirmed; leave it blank while unknown. Update descriptions, real photos, supplied accessories and warranty. No redeployment is needed for these admin edits.
4. Initial stock is received once as 10/6/2/4. Do not receive it again when editing a product. Use the inventory ledger with a reason for any later physical stock change.
5. Checkout remains closed until the separate launch requirements are fulfilled. Unpriced products remain unpurchasable even after the owner eventually opens checkout.

The versioned publication batch in `lib/initial-store-catalogue.mjs` creates the four approved listings and records initial stock once in the inventory ledger. Restarts do not replenish stock or overwrite later admin edits. Existing matching SKUs stop the batch for review. It does not open checkout or alter customer accounts, payments or policies. Pending details remain visible in the listing copy. Deployment and live verification are recorded in the matching release PR.
