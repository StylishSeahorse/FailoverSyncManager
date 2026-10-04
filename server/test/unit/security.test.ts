import { describe, expect, it } from 'vitest';
import { SecretBox } from '../../src/security/secretBox.js';
import { hashPassword, verifyPassword, passwordProblems } from '../../src/security/password.js';
import { redact, redactObject } from '../../src/security/redact.js';

describe('SecretBox', () => {
  const box = new SecretBox(Buffer.alloc(32, 1));

  it('round-trips a secret', () => {
    const enc = box.encrypt('cf-token-123456', 'cloudflare.api_token');
    expect(enc.ciphertext.toString('utf8')).not.toContain('cf-token');
    expect(box.decrypt(enc, 'cloudflare.api_token')).toBe('cf-token-123456');
  });

  it('uses a fresh IV per encryption', () => {
    const a = box.encrypt('same', 'p');
    const b = box.encrypt('same', 'p');
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it('rejects tampered ciphertext', () => {
    const enc = box.encrypt('secret-value', 'p');
    enc.ciphertext[0] = enc.ciphertext[0]! ^ 0xff;
    expect(() => box.decrypt(enc, 'p')).toThrow();
  });

  it('binds the ciphertext to its purpose', () => {
    const enc = box.encrypt('secret-value', 'proxmox.token');
    expect(() => box.decrypt(enc, 'cloudflare.api_token')).toThrow();
  });

  it('fails with the wrong key', () => {
    const enc = box.encrypt('secret-value', 'p');
    expect(() => new SecretBox(Buffer.alloc(32, 2)).decrypt(enc, 'p')).toThrow();
  });

  it('decrypts with a previous key version during rotation', () => {
    const old = new SecretBox(Buffer.alloc(32, 3), 1);
    const enc = old.encrypt('rotate-me', 'p');
    const rotated = new SecretBox(Buffer.alloc(32, 4), 2, { key: Buffer.alloc(32, 3), version: 1 });
    expect(rotated.decrypt(enc, 'p')).toBe('rotate-me');
    expect(rotated.encrypt('x', 'p').keyVersion).toBe(2);
  });

  it('refuses short keys', () => {
    expect(() => new SecretBox(Buffer.alloc(16))).toThrow();
  });
});

describe('passwords', () => {
  it('hashes and verifies', async () => {
    const h = await hashPassword('correct horse battery staple');
    expect(h).toMatch(/^scrypt\$/);
    expect(await verifyPassword('correct horse battery staple', h)).toBe(true);
    expect(await verifyPassword('wrong password!!', h)).toBe(false);
  });

  it('rejects malformed hashes', async () => {
    expect(await verifyPassword('x', 'plain')).toBe(false);
  });

  it('enforces a minimum length', () => {
    expect(passwordProblems('short')).not.toHaveLength(0);
    expect(passwordProblems('long enough password')).toHaveLength(0);
  });
});

describe('redaction', () => {
  it('removes known secret values', () => {
    expect(redact('token abcd1234efgh in message', ['abcd1234efgh'])).toBe('token [REDACTED] in message');
  });

  it('removes bearer and Proxmox tokens by pattern', () => {
    expect(redact('Authorization: Bearer xyz.abc-123')).toBe('Authorization: Bearer [REDACTED]');
    expect(redact('PVEAPIToken=fsm@pve!fsm=1111-2222')).toBe('PVEAPIToken=[REDACTED]');
    expect(redact('{"password":"hunter2hunter2"}')).toBe('{"password":"[REDACTED]"}');
  });

  it('redacts nested objects by key and value', () => {
    const out = redactObject({ a: { password: 'p', note: 'uses sekrit-value' }, list: ['sekrit-value'] }, ['sekrit-value']);
    expect(out).toEqual({ a: { password: '[REDACTED]', note: 'uses [REDACTED]' }, list: ['[REDACTED]'] });
  });
});
