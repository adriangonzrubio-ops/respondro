import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

function getKey(): Buffer {
    const key = process.env.ENCRYPTION_KEY;
    if (!key) throw new Error('ENCRYPTION_KEY env var is not set');
    return Buffer.from(key, 'hex');
}

/**
 * Encrypt a plaintext string.
 * Returns a base64 string containing: IV + AuthTag + Ciphertext
 * Safe to store in a TEXT column in Supabase.
 */
export function encrypt(plaintext: string): string {
    if (!plaintext) return '';

    const key = getKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(plaintext, 'utf8');
    encrypted = Buffer.concat([encrypted, cipher.final()]);

    const authTag = cipher.getAuthTag();

    // Pack: IV (16) + AuthTag (16) + Ciphertext (variable)
    const combined = Buffer.concat([iv, authTag, encrypted]);
    return 'enc:' + combined.toString('base64');
}

/**
 * Decrypt a previously encrypted string.
 * Accepts the base64 format produced by encrypt().
 * Also handles plaintext strings gracefully (for migration).
 */
export function decrypt(encryptedValue: string): string {
    if (!encryptedValue) return '';

    // If it's not encrypted (legacy plaintext), return as-is
    if (!encryptedValue.startsWith('enc:')) {
        return encryptedValue;
    }

    try {
        const key = getKey();
        const combined = Buffer.from(encryptedValue.slice(4), 'base64');

        // Unpack: IV (16) + AuthTag (16) + Ciphertext (rest)
        const iv = combined.subarray(0, IV_LENGTH);
        const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
        const ciphertext = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(authTag);

        let decrypted = decipher.update(ciphertext);
        decrypted = Buffer.concat([decrypted, decipher.final()]);

        return decrypted.toString('utf8');
    } catch (err: any) {
        console.error('Decryption failed:', err.message);
        // If decryption fails, it might be plaintext from before encryption was added
        return encryptedValue;
    }
}