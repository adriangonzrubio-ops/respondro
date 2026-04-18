import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * GET /api/config
 * Returns public-safe config for frontend pages (onboarding, pricing, etc.)
 */
export async function GET() {
    return NextResponse.json({
        supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL || '',
        supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
    });
}