import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

/**
 * GET /api/customer-profile?storeId=...&email=...
 * Returns the customer's profile (notes + tag_ids + customer_name)
 * Returns empty profile shape if not found.
 */
export async function GET(req: Request) {
    try {
        const { searchParams } = new URL(req.url);
        const storeId = searchParams.get('storeId');
        const email = searchParams.get('email');

        if (!storeId || !email) {
            return NextResponse.json({ error: 'storeId and email required' }, { status: 400 });
        }

        const { data, error } = await supabaseAdmin
            .from('customer_profiles')
            .select('*')
            .eq('store_id', storeId)
            .ilike('customer_email', email)
            .maybeSingle();

        if (error) {
            console.error('❌ customer-profile GET:', error.message);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        // Return empty shape if no profile yet
        return NextResponse.json({
            profile: data || {
                customer_email: email,
                customer_name: null,
                notes: '',
                tag_ids: []
            }
        });
    } catch (err: any) {
        console.error('❌ customer-profile GET error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

/**
 * PUT /api/customer-profile
 * Body: { storeId, email, customerName?, notes?, tagIds? }
 * Upserts the profile.
 */
export async function PUT(req: Request) {
    try {
        const body = await req.json();
        const { storeId, email, customerName, notes, tagIds } = body;

        if (!storeId || !email) {
            return NextResponse.json({ error: 'storeId and email required' }, { status: 400 });
        }

        const row: any = {
            store_id: storeId,
            customer_email: email.trim(),
            updated_at: new Date().toISOString()
        };
        if (customerName !== undefined) row.customer_name = customerName;
        if (notes !== undefined) row.notes = notes;
        if (tagIds !== undefined) row.tag_ids = Array.isArray(tagIds) ? tagIds : [];

        const { data, error } = await supabaseAdmin
            .from('customer_profiles')
            .upsert(row, { onConflict: 'store_id,customer_email' })
            .select()
            .single();

        if (error) {
            console.error('❌ customer-profile PUT:', error.message);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json({ profile: data });
    } catch (err: any) {
        console.error('❌ customer-profile PUT error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}