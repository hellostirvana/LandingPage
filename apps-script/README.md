# Stirvana Phase 1 intake backend

This folder is the auditable server-side counterpart to `form.html`. It contains no credentials and must not be served as part of the static site.

## What it does

- verifies reCAPTCHA v3 server-side;
- rejects malformed submissions and throttles repeated email submissions;
- ignores honeypot spam;
- deduplicates by submission ID;
- preserves the production `Guests` and `Chefs` tab contract;
- extends those tabs with submission IDs, structured supplier fields, source and status;
- creates or updates a supplier by submission ID or email, with status **Form Submitted**;
- sends a brief acknowledgement and an internal notification;
- escapes spreadsheet-formula prefixes before writing user input.

## Private configuration

Open the Stirvana-owned Google Apps Script project. In **Project Settings → Script properties**, retain the existing reCAPTCHA secret and add the remaining properties:

| Property | Required | Value |
|---|---:|---|
| `SPREADSHEET_ID` | Yes | ID of the private supplier pipeline spreadsheet |
| `RECAPTCHA_SECRET` | Yes | Secret paired with the public site key in `form.html` |
| `INTERNAL_NOTIFICATION_EMAIL` | Recommended | Private operations inbox |
| `RECAPTCHA_MIN_SCORE` | No | Defaults to `0.1` while production scores are being observed |

Never commit these values.

## Controlled deployment

1. Copy `Code.gs` and `appsscript.json` into the Stirvana-owned Apps Script project.
2. Confirm the private spreadsheet contains the existing tabs named `Guests` and `Chefs`. Do not rename them.
3. Make a dated backup copy of the spreadsheet before the first deployment.
4. Deploy as a Web app, executing as the Stirvana owner, with access set to anyone.
5. Submit one supplier test using a plus-addressed email and select two provider types.
6. Verify: the `Chefs` row contains both roles, a submission ID, `Form Submitted`, reCAPTCHA score/hostname, and the acknowledgement/internal emails arrive.
7. Submit one guest test and verify the `Guests` row and acknowledgement.
8. Replace `scriptURL` in `form.html` only if the deployment URL changed.
9. Publish the website only after both tests pass.

The public deployment URL is an endpoint, not a credential. Protection comes from server-side CAPTCHA verification, validation, throttling, deduplication, and keeping all IDs/secrets in Script Properties.
