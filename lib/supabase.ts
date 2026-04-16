import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!supabaseUrl || !supabaseAnonKey) {
  console.error('❌ Missing public Supabase environment variables!');
}

if (!supabaseServiceKey) {
  console.error('❌ Missing SUPABASE_SERVICE_ROLE_KEY! Server operations will fail.');
}

/**
 * Public client — safe to expose to browser.
 * Subject to Row Level Security (RLS) policies.
 * Use this for:
 *  - Client-side code (respondro.html)
 *  - Anything that runs in the browser
 */
export const supabase = createClient(supabaseUrl, supabaseAnonKey);

/**
 * Admin client — SERVER ONLY. Never import this in client-side code.
 * Bypasses Row Level Security. Full database access.
 * Use this for:
 *  - All API routes (app/api/**)
 *  - Background workers
 *  - Webhook handlers
 *  - Anything that needs to write across tenants
 */
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});