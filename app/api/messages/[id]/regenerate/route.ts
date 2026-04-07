import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { generateAiDraft } from '../../../../../lib/ai-generator';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { id } = await params;
        console.log("🚀 Starting regeneration for ID:", id);

        // 1. Fetch the message first
        const { data: message, error: msgError } = await supabase
            .from('messages')
            .select('*') 
            .eq('id', id)
            .single();

        if (msgError || !message) {
            console.error("❌ Step 1 Failed (Message):", msgError?.message);
            throw new Error(`Message not found: ${msgError?.message}`);
        }

        // 2. Fetch the connection to get the store_id
        const { data: connection, error: connError } = await supabase
            .from('user_connections')
            .select('store_id')
            .eq('id', message.connection_id)
            .single();

        if (connError || !connection) {
            console.error("❌ Step 2 Failed (Connection):", connError?.message);
            throw new Error(`Connection not found for this message.`);
        }

        // 3. Fetch settings for this store
        // We use .maybeSingle() so it doesn't crash if settings are missing
        const { data: settings, error: settError } = await supabase
            .from('settings')
            .select('*')
            .eq('store_id', connection.store_id)
            .maybeSingle();

        if (settError) {
            console.error("❌ Step 3 Failed (Settings):", settError.message);
        }

        console.log("🤖 Calling AI with signature:", settings?.signature ? "YES" : "NO");

        // 4. Generate the draft
        const aiDraft = await generateAiDraft({
            category: message.category || 'General Inquiry',
            body: message.body_text || "",
            rulebook: settings?.rulebook || "Be helpful and professional.",
            shopifyData: message.shopify_data || {},
            toneExamples: settings?.signature || "", 
            logoUrl: settings?.logo_url || ""
        });

        // 5. Update and return
        const { error: updateError } = await supabase
            .from('messages')
            .update({ ai_draft: aiDraft })
            .eq('id', id);

        if (updateError) throw new Error(`Update failed: ${updateError.message}`);

        return NextResponse.json({ draft: aiDraft });

    } catch (error: any) {
        console.error("❌ Critical Regenerate Error:", error.message);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}