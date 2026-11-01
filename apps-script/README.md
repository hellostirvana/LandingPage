# Stirvana Phase 1 intake backend

This folder is the auditable server-side counterpart to `form.html`. It contains no credentials and must not be served as part of the static site.

## What it does

- verifies reCAPTCHA v3 server-side;
- rejects malformed submissions and throttles repeated email submissions;
- ignores honeypot spam;
- deduplicates by submission ID;
- stores every accepted submission in a private `Website Intake` tab;
- creates or updates suppliers in `2 - SUPPLY LEADS` at **Form Submitted**;
- adds guest requests to `3 - DEMAND LEADS`;
- sends a brief acknowledgement and an internal notification;
- escapes spreadsheet-formula prefixes before writing user input.

## Private configuration

Create or open a Google Apps Script project owned by Stirvana. In **Project Settings → Script properties**, add:

| Property | Required | Value |
|---|---:|---|
| `SPREADSHEET_ID` | Yes | ID of the private supplier pipeline spreadsheet |
| `RECAPTCHA_SECRET` | Yes | Secret paired with the public site key in `form.html` |
| `INTERNAL_NOTIFICATION_EMAIL` | Recommended | Private operations inbox |
| `RECAPTCHA_MIN_SCORE` | No | Defaults to `0.5` |

Never commit these values.

## Controlled deployment

1. Copy `Code.gs` and `appsscript.json` into the Stirvana-owned Apps Script project.
2. Confirm the private spreadsheet contains tabs named `2 - SUPPLY LEADS` and `3 - DEMAND LEADS`.
3. Deploy as a Web app, executing as the Stirvana owner, with access set to anyone.
4. Submit one test supplier using a plus-addressed email.
5. Verify: one `Website Intake` row, one supplier pipeline row/update, acknowledgement email, and internal notification.
6. Replace `scriptURL` in `form.html` only if the deployment URL changed.
7. Re-test the guest form before publishing the site.

The public deployment URL is an endpoint, not a credential. Protection comes from server-side CAPTCHA verification, validation, throttling, deduplication, and keeping all IDs/secrets in Script Properties.
