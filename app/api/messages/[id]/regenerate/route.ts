import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { generateAiDraft } from '../../../../../lib/ai-generator';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { id } = await params;

        // 1. Fetch message and join 'user_connections' (the correct table name)
        const { data: message, error: msgError } = await supabase
            .from('messages')
            .select('*, user_connections(store_id)') 
            .eq('id', id)
            .single();

        if (msgError || !message) {
            console.error("❌ Message Fetch Error:", msgError);
            throw new Error("Message not found");
        }

        // 2. Fetch settings for this specific store
        // If this returns an error, we'll fall back to default empty strings
        const { data: settings } = await supabase
            .from('settings')
            .select('*')
            .eq('store_id', message.user_connections?.store_id)
            .single();

        // 3. Generate the draft
        const aiDraft = await generateAiDraft({
            category: message.category || 'General Inquiry',
            body: message.body_text || "",
            rulebook: settings?.rulebook || "Be helpful and professional.",
            shopifyData: message.shopify_data || {},
            toneExamples: settings?.signature || "", 
            logoUrl: settings?.logo_url || ""
        });

        // 4. Save and return
        await supabase.from('messages').update({ ai_draft: aiDraft }).eq('id', id);

        return NextResponse.json({ draft: aiDraft });

    } catch (error: any) {
        console.error("❌ Server Crash Detail:", error.message);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}