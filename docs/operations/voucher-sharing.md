# Voucher delivery and retired WhatsApp sharing (#131)

Customer voucher/account screens no longer offer WhatsApp sharing. The voucher URL/payload builder, its translations and dedicated styling are removed. Future referral/account features must follow the same policy. Voucher display, clipboard copy, authenticated repeated PDF download, explicit QR display, history and verified-email delivery remain supported.

Unrelated WhatsApp support remains available in Help and error recovery. Its prefilled text is generic: account numbers, voucher codes, MACs and raw errors are never put in third-party URL parameters. Support can be contacted without automatically disclosing credentials. Theme/language experiments stay disabled.

Automated verification includes a source policy regression and existing QR authorization coverage; a real local browser at320/1280px exercises active/expired/exhausted/all history, reload, copy/PDF/QR, verified receipt email and generic support. Provider mail in these tests is mocked. Exact local/CI results are recorded in the PR. No real provider send, purchase or router change is part of acceptance.

Release: source implementation; merged/deployed status belongs to the PR and release evidence. No external/provider/physical delivery is claimed by browser fixtures. Rollback restores the previous frontend artifact but would restore the retired sharing policy, so retain the new policy when rolling back another feature.
