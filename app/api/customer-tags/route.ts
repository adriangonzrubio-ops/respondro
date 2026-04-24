import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

/**
 * GET /api/customer-tags?storeId=...
 * Returns all tags defined by this store.
 */
export async function GET(req: Request) {
    try {
        const { searchParams } = new URL(req.url);
        const storeId = searchParams.get('storeId');

        if (!storeId) {
            return NextResponse.json({ error: 'storeId required' }, { status: 400 });
        }

        const { data, error } = await supabaseAdmin
            .from('customer_tags')
            .select('*')
            .eq('store_id', storeId)
            .order('name', { ascending: true });

        if (error) {
            console.error('❌ customer-tags GET:', error.message);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json({ tags: data || [] });
    } catch (err: any) {
        console.error('❌ customer-tags GET error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

/**
 * POST /api/customer-tags
 * Body: { storeId, name, color?, description? }
 * Creates a new tag for the store.
 */
export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { storeId, name, color, description } = body;

        if (!storeId || !name || !name.trim()) {
            return NextResponse.json({ error: 'storeId and name required' }, { status: 400 });
        }

        const row = {
            store_id: storeId,
            name: name.trim().substring(0, 40),
            color: color || '#5A6785',
            description: description || null
        };

        const { data, error } = await supabaseAdmin
            .from('customer_tags')
            .insert(row)
            .select()
            .single();

        if (error) {
            // Unique violation — tag already exists
            if (error.code === '23505') {
                return NextResponse.json({ error: 'A tag with this name already exists' }, { status: 409 });
            }
            console.error('❌ customer-tags POST:', error.message);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json({ tag: data });
    } catch (err: any) {
        console.error('❌ customer-tags POST error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

/**
 * DELETE /api/customer-tags?id=...&storeId=...
 * Deletes a tag. Also removes it from any customer profiles that reference it.
 */
export async function DELETE(req: Request) {
    try {
        const { searchParams } = new URL(req.url);
        const id = searchParams.get('id');
        const storeId = searchParams.get('storeId');

        if (!id || !storeId) {
            return NextResponse.json({ error: 'id and storeId required' }, { status: 400 });
        }

        // Remove this tag ID from any customer profiles that have it
        const { data: profilesWithTag } = await supabaseAdmin
            .from('customer_profiles')
            .select('id, tag_ids')
            .eq('store_id', storeId)
            .contains('tag_ids', [id]);

        if (profilesWithTag && profilesWithTag.length > 0) {
            for (const profile of profilesWithTag) {
                const newTagIds = (profile.tag_ids || []).filter((t: string) => t !== id);
                await supabaseAdmin
                    .from('customer_profiles')
                    .update({ tag_ids: newTagIds, updated_at: new Date().toISOString() })
                    .eq('id', profile.id);
            }
        }

        const { error } = await supabaseAdmin
            .from('customer_tags')
            .delete()
            .eq('id', id)
            .eq('store_id', storeId);

        if (error) {
            console.error('❌ customer-tags DELETE:', error.message);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json({ success: true, removedFromProfiles: profilesWithTag?.length || 0 });
    } catch (err: any) {
        console.error('❌ customer-tags DELETE error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}