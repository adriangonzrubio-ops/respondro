import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { generateAiDraft } from '@/lib/ai-generator';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { id } = await params;

        // 1. Fetch the message
        const { data: message } = await supabase.from('messages').select('*').eq('id', id).single();
        if (!message) return NextResponse.json({ error: "Message not found" }, { status: 404 });

        // 2. Fetch the Store ID (with deep fallback)
        let storeId = null;

        // Try to get it from the linked connection
        const { data: conn } = await supabase.from('user_connections').select('store_id').eq('id', message.connection_id).single();
        
        if (conn?.store_id) {
            storeId = conn.store_id;
        } else {
            // FALLBACK: If the link is broken, just use the first store in the DB (Safe for testing)
            const { data: firstStore } = await supabase.from('stores').select('id').limit(1).single();
            storeId = firstStore?.id;
        }

        // 3. Fetch Settings for that Store
        const { data: settings } = await supabase.from('settings').select('*').eq('store_id', storeId).maybeSingle();

        // 4. Generate the AI Draft
        const aiDraft = await generateAiDraft({
            category: message.category || 'General Inquiry',
            body: message.body_text || "",
            rulebook: settings?.rulebook || "Be professional.",
            shopifyData: message.shopify_data || {},
            toneExamples: settings?.signature || "", 
            logoUrl: settings?.logo_url || ""
        });

        // 5. Save and return
        await supabase.from('messages').update({ ai_draft: aiDraft }).eq('id', id);

        return NextResponse.json({ draft: aiDraft });

    } catch (error: any) {
        console.error("❌ Critical Regenerate Error:", error.message);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}