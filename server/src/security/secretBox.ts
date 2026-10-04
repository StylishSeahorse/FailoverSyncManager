import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface EncryptedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  keyVersion: number;
}

/**
 * AES-256-GCM encryption for stored credentials. The secret's purpose is bound
 * as additional authenticated data, so a ciphertext copied into another row
 * (e.g. swapping a Proxmox token for the Cloudflare one) fails to decrypt.
 */
export class SecretBox {
  private readonly keys = new Map<number, Buffer>();

  constructor(
    currentKey: Buffer,
    private readonly currentVersion = 1,
    previous?: { key: Buffer; version: number },
  ) {
    if (currentKey.length !== 32) throw new Error('Master key must be 32 bytes');
    this.keys.set(currentVersion, currentKey);
    if (previous) this.keys.set(previous.version, previous.key);
  }

  static fromBase64(b64: string): SecretBox {
    return new SecretBox(Buffer.from(b64, 'base64'));
  }

  encrypt(plaintext: string, purpose: string): EncryptedSecret {
    const key = this.keys.get(this.currentVersion)!;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(purpose, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return { ciphertext, iv, authTag: cipher.getAuthTag(), keyVersion: this.currentVersion };
  }

  decrypt(secret: EncryptedSecret, purpose: string): string {
    const key = this.keys.get(secret.keyVersion);
    if (!key) throw new Error(`No key available for key version ${secret.keyVersion}`);
    const decipher = createDecipheriv('aes-256-gcm', key, secret.iv);
    decipher.setAAD(Buffer.from(purpose, 'utf8'));
    decipher.setAuthTag(secret.authTag);
    return Buffer.concat([decipher.update(secret.ciphertext), decipher.final()]).toString('utf8');
  }
}
