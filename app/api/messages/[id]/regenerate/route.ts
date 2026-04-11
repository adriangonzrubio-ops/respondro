import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { generateAiDraft } from '@/lib/ai-generator';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { id } = await params;

        // Read the request body (contains optional rulebook override from frontend)
        const body = await req.json().catch(() => ({}));

        // 1. Fetch the message
        const { data: message } = await supabase.from('messages').select('*').eq('id', id).single();
        if (!message) return NextResponse.json({ error: "Message not found" }, { status: 404 });

        // 2. Fetch the Store ID (with deep fallback)
        let storeId = null;
        const { data: conn } = await supabase.from('user_connections').select('store_id').eq('id', message.connection_id).single();
        
        if (conn?.store_id) {
            storeId = conn.store_id;
        } else {
            const { data: firstStore } = await supabase.from('stores').select('id').limit(1).single();
            storeId = firstStore?.id;
        }

        // 3. Fetch Settings for that Store
        const { data: settings } = await supabase.from('settings').select('*').eq('store_id', storeId).maybeSingle();

        // 4. Use frontend rulebook if provided, otherwise use database rulebook
        const finalRulebook = body.rulebook || settings?.rulebook || "Be professional.";
        const finalSignature = body.signature || settings?.signature || "";

        // 5. Generate the AI Draft
        const aiDraft = await generateAiDraft({
            category: message.category || 'General Inquiry',
            body: message.body_text || "",
            rulebook: finalRulebook,
            shopifyData: message.shopify_data || {},
            toneExamples: finalSignature,
            logoUrl: settings?.logo_url || ""
        });

        // 6. Save and return
        await supabase.from('messages').update({ ai_draft: aiDraft }).eq('id', id);

        return NextResponse.json({ draft: aiDraft });

    } catch (error: any) {
        console.error("❌ Critical Regenerate Error:", error.message);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}