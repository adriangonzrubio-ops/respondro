import { NextResponse } from 'next/server';
import { supabase } from '../../../../../lib/supabase';
import { generateAiDraft } from '../../../../../lib/ai-generator';

export async function POST(req: Request, { params }: { params: { id: string } }) {
    try {
        const { id } = params;

        // 1. Get the original message and store settings
        const { data: msg, error: msgError } = await supabase
            .from('messages')
            .select('*')
            .eq('id', id)
            .single();

        const { data: settings } = await supabase.from('settings').select('*').single();

        if (msgError || !msg) {
            return NextResponse.json({ error: "Message not found" }, { status: 404 });
        }

        // 2. Run Claude again using the Rulebook and Shopify context
        const newDraft = await generateAiDraft({
            category: msg.category,
            body: msg.body_text,
            rulebook: settings?.rulebook || '',
            shopifyData: msg.shopify_data,
            toneExamples: settings?.signature || ''
        });

        // 3. Update the database with the fresh Claude draft
        await supabase
            .from('messages')
            .update({ ai_draft: newDraft })
            .eq('id', id);

        return NextResponse.json({ ai_draft: newDraft });
    } catch (error: any) {
        console.error("Regeneration Error:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}