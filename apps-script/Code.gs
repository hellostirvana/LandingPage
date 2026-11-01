/**
 * Stirvana Phase 1 intake backend.
 * Secrets and private IDs belong in Apps Script Properties, never in GitHub.
 */
const CONFIG = {
  intakeSheet: 'Website Intake',
  supplySheet: '2 - SUPPLY LEADS',
  demandSheet: '3 - DEMAND LEADS',
  recaptchaAction: 'submit',
  defaultScore: 0.5,
  maxPerTenMinutes: 4
};

function doPost(e) {
  try {
    const payload = parsePayload_(e);
    if (payload.website) return json_({ result: 'success' }); // honeypot: do not teach bots

    validatePayload_(payload);
    verifyRecaptcha_(payload.recaptchaToken);
    enforceRateLimit_(payload.email);

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      saveIntake_(payload);
      if (payload.role === 'Chef') upsertSupplier_(payload);
      if (payload.role === 'Guest') appendDemand_(payload);
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

function saveIntake_(p) {
  const ss = spreadsheet_();
  const sheet = ss.getSheetByName(CONFIG.intakeSheet) || ss.insertSheet(CONFIG.intakeSheet);
  const headers = ['Received At', 'Submission ID', 'Role', 'Name', 'Email', 'Phone', 'City', 'Business', 'Provider Types', 'Contributions', 'Experience', 'Readiness', 'Source', 'Raw Summary'];
  if (sheet.getLastRow() === 0) sheet.appendRow(headers);
  if (findInColumn_(sheet, 2, p.submission_id)) return;
  sheet.appendRow(safeRow_([
    p.received_at, p.submission_id, p.role, p.name, p.email, p.phone, p.city,
    p.business_name, p.provider_type, p.hosting_interest, p.hosting_idea || p.cuisine_interest,
    p.pilot_readiness, p.utm_source || p.ref || 'Website', p.experience || p.guest_notes
  ]));
}

function upsertSupplier_(p) {
  const sheet = spreadsheet_().getSheetByName(CONFIG.supplySheet);
  if (!sheet) throw new Error('CONFIG:Supply pipeline tab not found');
  const row = findSupplierRow_(sheet, p);
  const now = new Date();
  const values = [
    'P2', p.business_name || p.name, p.provider_type, p.city,
    [p.phone, p.email].filter(Boolean).join(' / '), 'Form Submitted', now,
    'Website supplier form submitted', 'Review and schedule discovery', '',
    'Yes', p.utm_source || p.ref || 'Website supplier form',
    'Submission ' + p.submission_id, 'Form Submitted', '0 - Not assessed',
    p.name, p.provider_type + ' | ' + p.hosting_interest,
    p.hosting_idea || p.experience, p.comfortable_capacity, p.minimum_economics,
    '', p.pilot_readiness, 'Not started', p.compliance_notes
  ];
  if (row) sheet.getRange(row, 1, 1, values.length).setValues([safeRow_(values)]);
  else sheet.appendRow(safeRow_(values));
}

function appendDemand_(p) {
  const sheet = spreadsheet_().getSheetByName(CONFIG.demandSheet);
  if (!sheet) return;
  if (findTextRow_(sheet, p.email)) return;
  sheet.appendRow(safeRow_([
    'P2', p.name, 'Guest', p.city, [p.phone, p.email].filter(Boolean).join(' / '),
    'Form Submitted', new Date(), 'Website guest form submitted',
    'Review for relevant founding table', '', 'Website', p.guest_notes || ''
  ]));
}

function findSupplierRow_(sheet, p) {
  const values = sheet.getDataRange().getDisplayValues();
  const email = p.email.toLowerCase();
  const business = String(p.business_name || '').toLowerCase();
  for (let i = 1; i < values.length; i++) {
    const contact = String(values[i][4] || '').toLowerCase();
    const name = String(values[i][1] || '').toLowerCase();
    if ((email && contact.indexOf(email) !== -1) || (business && name === business)) return i + 1;
  }
  return 0;
}

function findTextRow_(sheet, text) {
  const values = sheet.getDataRange().getDisplayValues();
  const needle = String(text || '').toLowerCase();
  for (let i = 1; i < values.length; i++) {
    if (values[i].join(' ').toLowerCase().indexOf(needle) !== -1) return i + 1;
  }
  return 0;
}

function findInColumn_(sheet, column, value) {
  if (sheet.getLastRow() < 2) return false;
  return sheet.getRange(2, column, sheet.getLastRow() - 1, 1).getDisplayValues().some(function (row) {
    return row[0] === value;
  });
}

function sendAcknowledgement_(p) {
  const subject = p.role === 'Chef' ? 'Stirvana hosting interest received' : 'Stirvana seat request received';
  const body = p.role === 'Chef'
    ? 'Hi ' + p.name + ',\n\nThank you for sharing your interest in collaborating with Stirvana. We will review your details and contact you if there is a useful next conversation. Submitting this form does not create a booking or agreement.\n\n— Stirvana'
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
    if (value instanceof Date) return value;
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
