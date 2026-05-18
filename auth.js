// auth.js — Custom Auth System (Native crypto for TOTP, jsonwebtoken for JWT, qrcode for QR)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const jwt = require('jsonwebtoken');

const DATA_DIR = path.join(__dirname, 'data');
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');

// Get persistent JWT secret from config or env, else a per-process random one.
// An ephemeral secret invalidates sessions on restart, which is far safer than
// signing tokens with a predictable hardcoded key.
let ephemeralJwtSecret = null;

function getJwtSecret() {
  const config = getAuthConfig();
  if (config && config.jwtSecret) return config.jwtSecret;
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (!ephemeralJwtSecret) {
    ephemeralJwtSecret = crypto.randomBytes(32).toString('hex');
    console.warn('[Auth] No persistent JWT secret — generated an ephemeral one. Set JWT_SECRET to keep sessions across restarts.');
  }
  return ephemeralJwtSecret;
}

// ── Base32 Encoding / Decoding ──
const RFC4648_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer) {
  let length = buffer.length;
  let bits = 0;
  let value = 0;
  let output = '';
  for (let i = 0; i < length; i++) {
    value = (value << 8) | buffer[i];
    bits += 8;
    while (bits >= 5) {
      output += RFC4648_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += RFC4648_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(input) {
  input = input.replace(/=+$/, '').toUpperCase();
  let length = input.length;
  let bits = 0;
  let value = 0;
  let index = 0;
  let output = new Uint8Array((length * 5 / 8) | 0);
  for (let i = 0; i < length; i++) {
    let charCode = input.charCodeAt(i);
    let charValue = RFC4648_ALPHABET.indexOf(String.fromCharCode(charCode));
    if (charValue === -1) continue;
    value = (value << 5) | charValue;
    bits += 5;
    if (bits >= 8) {
      output[index++] = (value >>> (bits - 8)) & 255;
      bits -= 8;
    }
  }
  return Buffer.from(output.buffer);
}

// ── TOTP Implementation ──
function generateTOTPSecret() {
  const buffer = crypto.randomBytes(20);
  return base32Encode(buffer);
}

function verifyTOTP(token, secret, window = 1) {
  if (!token || token.length !== 6) return false;
  
  const key = base32Decode(secret);
  const epoch = Math.floor(Date.now() / 1000);
  const timeStep = Math.floor(epoch / 30);
  
  for (let i = -window; i <= window; i++) {
    const timeBuffer = Buffer.alloc(8);
    timeBuffer.writeUInt32BE(Math.floor((timeStep + i) / 4294967296), 0);
    timeBuffer.writeUInt32BE((timeStep + i) % 4294967296, 4);
    
    const hmac = crypto.createHmac('sha1', key);
    hmac.update(timeBuffer);
    const result = hmac.digest();
    
    const offset = result[result.length - 1] & 0xf;
    const code = (
      ((result[offset] & 0x7f) << 24) |
      ((result[offset + 1] & 0xff) << 16) |
      ((result[offset + 2] & 0xff) << 8) |
      (result[offset + 3] & 0xff)
    ) % 1000000;
    
    if (code.toString().padStart(6, '0') === token) {
      return true;
    }
  }
  return false;
}

// ── QR Code ──
async function generateQRCode(secret) {
  const otpauth = `otpauth://totp/DockerSnoozingPortal:Admin?secret=${secret}&issuer=DockerSnoozingPortal`;
  return await QRCode.toDataURL(otpauth);
}

// ── Auth Config Management ──
function getAuthConfig() {
  if (fs.existsSync(AUTH_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8'));
    } catch (e) {
      console.error('[Auth] Failed to read auth.json', e.message);
    }
  }
  return null;
}

function saveAuthConfig(config) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(AUTH_FILE, JSON.stringify(config, null, 2));
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derivedKey}`;
}

function verifyPassword(password, hash) {
  if (!hash) return false;
  const [salt, key] = hash.split(':');
  if (!salt || !key) return false;
  const keyBuffer = Buffer.from(key, 'hex');
  const derivedKey = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(keyBuffer, derivedKey);
}

function generateJWT() {
  return jwt.sign({ user: 'admin' }, getJwtSecret(), { expiresIn: '24h' });
}

function verifyJWT(token) {
  try {
    return jwt.verify(token, getJwtSecret());
  } catch (e) {
    return null;
  }
}

module.exports = {
  getAuthConfig,
  saveAuthConfig,
  hashPassword,
  verifyPassword,
  generateTOTPSecret,
  generateQRCode,
  verifyTOTP,
  generateJWT,
  verifyJWT
};
