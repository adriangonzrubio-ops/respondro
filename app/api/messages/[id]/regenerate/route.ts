import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { generateAiDraft } from '@/lib/ai-generator';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { id } = await params;
        console.log("🚀 Starting regeneration for Message ID:", id);

        // 1. Fetch the message first
        const { data: message, error: msgError } = await supabase
            .from('messages')
            .select('*')
            .eq('id', id)
            .single();

        if (msgError || !message) throw new Error("Message not found in database.");

        // 2. Fetch the connection to find the store_id (no join, just a simple query)
        const { data: connection, error: connError } = await supabase
            .from('user_connections')
            .select('store_id')
            .eq('id', message.connection_id)
            .single();

        if (connError || !connection) throw new Error("Could not find the Shopify connection for this message.");

        // 3. Fetch settings for this specific store
        const { data: settings } = await supabase
            .from('settings')
            .select('*')
            .eq('store_id', connection.store_id)
            .single();

        // 4. Generate the AI Draft
        const aiDraft = await generateAiDraft({
            category: message.category || 'General Inquiry',
            body: message.body_text || "",
            rulebook: settings?.rulebook || "Be professional.",
            shopifyData: message.shopify_data || {},
            toneExamples: settings?.signature || "", 
            logoUrl: settings?.logo_url || ""
        });

        // 5. Save the new draft back to Supabase
        const { error: updateError } = await supabase
            .from('messages')
            .update({ ai_draft: aiDraft })
            .eq('id', id);

        if (updateError) throw new Error("Failed to save the new draft.");

        return NextResponse.json({ draft: aiDraft });

    } catch (error: any) {
        console.error("❌ Regeneration Crash:", error.message);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}