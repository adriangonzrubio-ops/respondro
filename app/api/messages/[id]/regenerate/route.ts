import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { generateAiDraft } from '../../../../../lib/ai-generator';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { id } = await params;

        // 1. Fetch the message AND the associated store ID via the connection
        // We use the 'connections' join to make sure we get the right merchant's data
        const { data: message } = await supabase
            .from('messages')
            .select('*, connections(store_id)') 
            .eq('id', id)
            .single();

        if (!message || !message.connections) throw new Error("Message or Store connection not found");

        // 2. Fetch the specific settings for THIS store (SaaS standard)
        const { data: settings } = await supabase
            .from('settings')
            .select('*')
            .eq('store_id', message.connections.store_id)
            .single();

        // 3. Generate the draft using the official signature from the database
        const aiDraft = await generateAiDraft({
            category: message.category || 'General Inquiry',
            body: message.body_text,
            rulebook: settings?.rulebook || "Be professional.",
            shopifyData: message.shopify_data || {},
            toneExamples: settings?.signature || "", // This fixes the missing signature!
            logoUrl: settings?.logo_url || ""
        });

        // 4. Update the message with the new draft in Supabase
        await supabase
            .from('messages')
            .update({ ai_draft: aiDraft })
            .eq('id', id);

        return NextResponse.json({ draft: aiDraft });

    } catch (error: any) {
        console.error("❌ SaaS Regeneration Crash:", error.message);
        return NextResponse.json({ 
            error: "Drafting failed. Please check your Shopify connection or AI credits.",
            details: error.message 
        }, { status: 500 });
    }
}