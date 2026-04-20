/**
 * ONE-TIME MIGRATION SCRIPT
 * Encrypts existing plaintext tokens in Supabase.
 *
 * Safe to run multiple times — skips rows that are already encrypted (start with 'enc:').
 *
 * Run with: npx tsx scripts/migrate-encrypt-tokens.ts
 */

import { createClient } from '@supabase/supabase-js';
import { encrypt } from '../lib/encryption';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env.local so we get the local env vars (ENCRYPTION_KEY, SUPABASE keys)
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL) {
    console.error('❌ NEXT_PUBLIC_SUPABASE_URL not found in .env.local');
    process.exit(1);
}
if (!SUPABASE_SERVICE_KEY) {
    console.error('❌ SUPABASE_SERVICE_ROLE_KEY not found in .env.local');
    process.exit(1);
}
if (!process.env.ENCRYPTION_KEY) {
    console.error('❌ ENCRYPTION_KEY not found in .env.local');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function main() {
    console.log('🔐 Starting token encryption migration...\n');

    // ─── 1. Migrate stores.shopify_token ─────────────────────────
    console.log('📦 Migrating stores.shopify_token...');
    const { data: stores, error: storesError } = await supabase
        .from('stores')
        .select('id, shopify_url, shopify_token');

    if (storesError) {
        console.error('❌ Failed to fetch stores:', storesError.message);
        process.exit(1);
    }

    let storesEncrypted = 0;
    let storesSkipped = 0;

    for (const store of stores || []) {
        if (!store.shopify_token) {
            console.log(`  ⏭️  ${store.shopify_url}: no token, skipped`);
            storesSkipped++;
            continue;
        }
        if (store.shopify_token.startsWith('enc:')) {
            console.log(`  ✓ ${store.shopify_url}: already encrypted, skipped`);
            storesSkipped++;
            continue;
        }

        const encrypted = encrypt(store.shopify_token);
        const { error: updateError } = await supabase
            .from('stores')
            .update({ shopify_token: encrypted })
            .eq('id', store.id);

        if (updateError) {
            console.error(`  ❌ ${store.shopify_url}: update failed — ${updateError.message}`);
        } else {
            console.log(`  🔒 ${store.shopify_url}: encrypted`);
            storesEncrypted++;
        }
    }

    console.log(`\n  Total: ${storesEncrypted} encrypted, ${storesSkipped} skipped\n`);

    // ─── 2. Migrate user_connections Gmail tokens ─────────────────
    console.log('📧 Migrating user_connections Gmail tokens...');
    const { data: connections, error: connError } = await supabase
        .from('user_connections')
        .select('id, email, gmail_access_token, gmail_refresh_token');

    if (connError) {
        console.error('❌ Failed to fetch connections:', connError.message);
        process.exit(1);
    }

    let connEncrypted = 0;
    let connSkipped = 0;

    for (const conn of connections || []) {
        const updates: any = {};

        if (conn.gmail_access_token && !conn.gmail_access_token.startsWith('enc:')) {
            updates.gmail_access_token = encrypt(conn.gmail_access_token);
        }
        if (conn.gmail_refresh_token && !conn.gmail_refresh_token.startsWith('enc:')) {
            updates.gmail_refresh_token = encrypt(conn.gmail_refresh_token);
        }

        if (Object.keys(updates).length === 0) {
            console.log(`  ✓ ${conn.email}: nothing to encrypt, skipped`);
            connSkipped++;
            continue;
        }

        const { error: updateError } = await supabase
            .from('user_connections')
            .update(updates)
            .eq('id', conn.id);

        if (updateError) {
            console.error(`  ❌ ${conn.email}: update failed — ${updateError.message}`);
        } else {
            const fieldsEncrypted = Object.keys(updates).join(', ');
            console.log(`  🔒 ${conn.email}: encrypted (${fieldsEncrypted})`);
            connEncrypted++;
        }
    }

    console.log(`\n  Total: ${connEncrypted} encrypted, ${connSkipped} skipped\n`);

    console.log('✅ Migration complete.');
}

main().catch(err => {
    console.error('❌ Unhandled error:', err);
    process.exit(1);
});