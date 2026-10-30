'use strict';

// Canonical identifiers minted by the matching account service. Keeping these
// at the client boundary prevents vault corruption and hostile response text
// from becoming URL, header, log or allocation input elsewhere in the stack.
const PAIR_ID_SHAPE = /^pair-[0-9a-f]{32}$/;
const DEVICE_ID_SHAPE = /^device-[0-9a-f]{24}$/;
const DEVICE_TOKEN_SHAPE = /^dt_[A-Za-z0-9_-]{43}$/;
const CLAIM_CODE_SHAPE = /^TC-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/;
const BASE64URL_SHAPE = /^[A-Za-z0-9_-]+$/;
const CONTROL = /[\x00-\x1f\x7f]/;

const isPairId = value => typeof value === 'string' && PAIR_ID_SHAPE.test(value);
const isDeviceId = value => typeof value === 'string' && DEVICE_ID_SHAPE.test(value);
const isDeviceToken = value => typeof value === 'string' && DEVICE_TOKEN_SHAPE.test(value);
const isGeneration = value => Number.isSafeInteger(value) && value > 0;
const isTimestamp = value => Number.isSafeInteger(value) && value > 0;
const isIntervalSeconds = value => Number.isSafeInteger(value) && value >= 1 && value <= 300;
const isDeviceName = value => typeof value === 'string' && value.length >= 1 && value.length <= 120
  && value === value.trim() && !CONTROL.test(value);
const isClaimCode = value => typeof value === 'string' && CLAIM_CODE_SHAPE.test(value);
const isPollToken = value => typeof value === 'string' && value.length >= 1 && value.length <= 256
  && BASE64URL_SHAPE.test(value);
const isEmailText = value => typeof value === 'string' && value.length >= 3 && value.length <= 254
  && value === value.trim() && !CONTROL.test(value);
const isSessionCookie = value => typeof value === 'string' && value.length >= 3 && value.length <= 4096
  && /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+=[\x21-\x3a\x3c-\x7e]*$/.test(value);
const isOptionalPem = value => value === null || (typeof value === 'string' && value.length >= 1 && value.length <= 64 * 1024);

module.exports = Object.freeze({
  PAIR_ID_SHAPE, DEVICE_ID_SHAPE, DEVICE_TOKEN_SHAPE, CLAIM_CODE_SHAPE,
  isPairId, isDeviceId, isDeviceToken, isGeneration, isTimestamp,
  isIntervalSeconds, isDeviceName, isClaimCode, isPollToken, isEmailText,
  isSessionCookie, isOptionalPem
});
