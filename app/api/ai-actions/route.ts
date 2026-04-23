import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

/**
 * GET /api/ai-actions?storeId=...&range=today|7d|month&limit=50
 * Returns paginated AI activity log, newest first.
 */
export async function GET(req: Request) {
    try {
        const { searchParams } = new URL(req.url);
        const storeId = searchParams.get('storeId');
        const range = searchParams.get('range') || '7d';
        const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 200);

        if (!storeId) {
            return NextResponse.json({ error: 'storeId required' }, { status: 400 });
        }

        // Calculate date cutoff
        const now = new Date();
        let cutoff: Date;
        if (range === 'today') {
            cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        } else if (range === 'month') {
            cutoff = new Date(now.getFullYear(), now.getMonth(), 1);
        } else {
            // default 7d
            cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        }

        const { data: actions, error } = await supabaseAdmin
            .from('ai_actions')
            .select('*')
            .eq('store_id', storeId)
            .gte('created_at', cutoff.toISOString())
            .order('created_at', { ascending: false })
            .limit(limit);

        if (error) {
            console.error('❌ Fetch ai_actions failed:', error.message);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json({
            actions: actions || [],
            count: actions?.length || 0,
            range
        });

    } catch (error: any) {
        console.error('❌ ai-actions GET error:', error.message);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}