/**
 * Stirvana Phase 1 intake backend.
 * Production contract: existing Guests and Chefs tabs.
 * Secrets and private IDs belong in Apps Script Properties, never in GitHub.
 */
const CONFIG = {
  guestSheet: 'Guests',
  supplierSheet: 'Chefs',
  recaptchaAction: 'submit',
  allowedHostnames: ['stirvana.food', 'www.stirvana.food'],
  defaultScore: 0.1,
  maxPerTenMinutes: 4
};

const GUEST_HEADERS = [
  'Timestamp', 'name', 'city', 'email', 'phone', 'Cuisine Interest', 'notes',
  'reCAPTCHA Score', 'reCAPTCHA Hostname', 'Submission ID', 'Form Version',
  'Submitted At', 'Source', 'Status'
];

const SUPPLIER_HEADERS = [
  'Timestamp', 'name', 'city', 'email', 'phone', 'Specialty', 'Experience',
  'reCAPTCHA Score', 'reCAPTCHA Hostname', 'Submission ID', 'Business Name',
  'Provider Types', 'Contributions', 'Venue Access', 'Comfortable Capacity',
  'Availability', 'Minimum Economics', 'Pilot Readiness', 'Compliance Notes',
  'Source', 'Form Version', 'Submitted At', 'Status'
];

function doPost(e) {
  try {
    const payload = parsePayload_(e);
    if (payload.website) return json_({ result: 'success' });

    validatePayload_(payload);
    const captcha = verifyRecaptcha_(payload.recaptchaToken);
    payload.recaptcha_score = captcha.score;
    payload.recaptcha_hostname = captcha.hostname;
    enforceRateLimit_(payload.email);

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      saveSubmission_(payload);
    } finally {
      lock.releaseLock();
    }

    sendAcknowledgement_(payload);
    sendInternalNotification_(payload);
    return json_({ result: 'success', submissionId: payload.submission_id });
  } catch (error) {
    console.error(error);
    return json_({ result: 'error', message: publicMessage_(error) });
  }
}

function parsePayload_(e) {
  const source = (e && e.parameter) || {};
  const payload = {};
  Object.keys(source).forEach(function (key) {
    payload[key] = clean_(source[key], limitFor_(key));
  });
  payload.email = String(payload.email || '').toLowerCase();
  payload.submission_id = payload.submission_id || Utilities.getUuid();
  payload.received_at = new Date();
  return payload;
}

function validatePayload_(p) {
  ['name', 'email', 'city', 'role', 'submission_id'].forEach(function (key) {
    if (!p[key]) throw new Error('VALIDATION:Missing ' + key);
  });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) throw new Error('VALIDATION:Invalid email');
  if (['Chef', 'Guest'].indexOf(p.role) === -1) throw new Error('VALIDATION:Invalid role');
  if (p.role === 'Chef' && (!p.provider_type || !p.hosting_interest || !p.experience)) {
    throw new Error('VALIDATION:Incomplete supplier application');
  }
}

function verifyRecaptcha_(token) {
  if (!token) throw new Error('CAPTCHA:Missing token');
  const props = PropertiesService.getScriptProperties();
  const secret = props.getProperty('RECAPTCHA_SECRET');
  if (!secret) throw new Error('CONFIG:RECAPTCHA_SECRET is missing');

  const response = UrlFetchApp.fetch('https://www.google.com/recaptcha/api/siteverify', {
    method: 'post',
    payload: { secret: secret, response: token },
    muteHttpExceptions: true
  });
  const result = JSON.parse(response.getContentText() || '{}');
  const threshold = Number(props.getProperty('RECAPTCHA_MIN_SCORE') || CONFIG.defaultScore);
  if (!result.success || result.action !== CONFIG.recaptchaAction || Number(result.score || 0) < threshold) {
    throw new Error('CAPTCHA:Verification failed');
  }
  return result;
}

function enforceRateLimit_(email) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, email);
  const key = 'rate-' + Utilities.base64EncodeWebSafe(digest).slice(0, 32);
  const cache = CacheService.getScriptCache();
  const count = Number(cache.get(key) || 0) + 1;
  if (count > CONFIG.maxPerTenMinutes) throw new Error('RATE:Too many attempts');
  cache.put(key, String(count), 600);
}

function spreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('CONFIG:SPREADSHEET_ID is missing');
  return SpreadsheetApp.openById(id);
}

function saveSubmission_(p) {
  const ss = spreadsheet_();
  if (p.role === 'Chef') {
    const sheet = requireSheet_(ss, CONFIG.supplierSheet);
    ensureHeaders_(sheet, SUPPLIER_HEADERS);
    const row = [
      p.received_at, p.name, p.city, p.email, p.phone, p.specialty || p.hosting_interest,
      p.experience, p.recaptcha_score, p.recaptcha_hostname, p.submission_id,
      p.business_name, p.provider_type, p.hosting_interest, p.venue_access,
      p.comfortable_capacity, p.provider_availability, p.minimum_economics,
      p.pilot_readiness, p.compliance_notes, source_(p), p.form_version,
      p.submitted_at, 'Form Submitted'
    ];
    upsertByEmailOrSubmission_(sheet, row, p.email, p.submission_id);
  } else {
    const sheet = requireSheet_(ss, CONFIG.guestSheet);
    ensureHeaders_(sheet, GUEST_HEADERS);
    const row = [
      p.received_at, p.name, p.city, p.email, p.phone, p.cuisine_interest,
      p.guest_notes, p.recaptcha_score, p.recaptcha_hostname, p.submission_id,
      p.form_version, p.submitted_at, source_(p), 'Form Submitted'
    ];
    upsertByEmailOrSubmission_(sheet, row, p.email, p.submission_id);
  }
}

function requireSheet_(ss, name) {
  const sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('CONFIG:Required tab not found: ' + name);
  return sheet;
}

function ensureHeaders_(sheet, headers) {
  const existing = sheet.getRange(1, 1, 1, headers.length).getDisplayValues()[0];
  for (let i = 0; i < headers.length; i++) {
    if (existing[i] && existing[i] !== headers[i]) {
      throw new Error('CONFIG:Unexpected header in ' + sheet.getName() + ' column ' + (i + 1));
    }
  }
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
}

function upsertByEmailOrSubmission_(sheet, values, email, submissionId) {
  const lastRow = sheet.getLastRow();
  let targetRow = 0;
  if (lastRow >= 2) {
    const width = Math.max(10, values.length);
    const rows = sheet.getRange(2, 1, lastRow - 1, width).getDisplayValues();
    for (let i = 0; i < rows.length; i++) {
      const rowEmail = String(rows[i][3] || '').toLowerCase();
      const rowSubmission = String(rows[i][9] || '');
      if ((submissionId && rowSubmission === submissionId) || (email && rowEmail === email)) {
        targetRow = i + 2;
        break;
      }
    }
  }
  const safe = safeRow_(values);
  if (targetRow) sheet.getRange(targetRow, 1, 1, safe.length).setValues([safe]);
  else sheet.appendRow(safe);
}

function source_(p) {
  return p.utm_source || p.ref || 'Website';
}

function sendAcknowledgement_(p) {
  const supplier = p.role === 'Chef';
  const subject = supplier ? 'Stirvana hosting interest received' : 'Stirvana seat request received';
  const body = supplier
    ? 'Hi ' + p.name + ',\n\nThank you for sharing your interest in collaborating with Stirvana. We will review your details and contact you about the next conversation. Submitting this form does not create a booking or agreement.\n\n— Stirvana'
    : 'Hi ' + p.name + ',\n\nThank you. We received your Stirvana seat request and will reach out when there is a relevant next step. This is not a confirmed reservation.\n\n— Stirvana';
  try { MailApp.sendEmail({ to: p.email, subject: subject, body: body, name: 'Stirvana' }); }
  catch (error) { console.error('Acknowledgement email failed', error); }
}

function sendInternalNotification_(p) {
  const to = PropertiesService.getScriptProperties().getProperty('INTERNAL_NOTIFICATION_EMAIL');
  if (!to) return;
  const subject = '[Stirvana intake] ' + p.role + ': ' + (p.business_name || p.name);
  const body = [
    'Submission: ' + p.submission_id,
    'Name: ' + p.name,
    'Business: ' + (p.business_name || ''),
    'Email: ' + p.email,
    'Phone: ' + (p.phone || ''),
    'City: ' + p.city,
    'Provider types: ' + (p.provider_type || ''),
    'Contributions: ' + (p.hosting_interest || ''),
    '',
    p.experience || p.guest_notes || ''
  ].join('\n');
  try { MailApp.sendEmail({ to: to, subject: subject, body: body, name: 'Stirvana Intake' }); }
  catch (error) { console.error('Internal notification failed', error); }
}

function clean_(value, maxLength) {
  return String(value == null ? '' : value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, maxLength);
}

function limitFor_(key) {
  if (['experience', 'guest_notes', 'hosting_idea', 'host_notes', 'compliance_notes'].indexOf(key) !== -1) return 4000;
  if (key === 'recaptchaToken') return 5000;
  return 500;
}

function safeRow_(values) {
  return values.map(function (value) {
    if (value instanceof Date || typeof value === 'number') return value;
    const text = String(value == null ? '' : value);
    return /^[=+\-@]/.test(text) ? "'" + text : text;
  });
}

function publicMessage_(error) {
  const message = String(error && error.message || '');
  if (message.indexOf('RATE:') === 0) return 'Please wait a few minutes and try again.';
  if (message.indexOf('VALIDATION:') === 0) return 'Please review the form and try again.';
  if (message.indexOf('CAPTCHA:') === 0) return 'We could not verify the submission. Please try again.';
  return 'We could not process the form. Please try again.';
}

function json_(body) {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON);
}
