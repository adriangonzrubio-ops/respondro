import { NextResponse } from 'next/server';
import { supabase } from '../../../../../lib/supabase';
import { generateAiDraft } from '../../../../../lib/ai-generator';

// The "Promise" in the type below is what satisfies the new Next.js rules
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        // We MUST await params now
        const { id } = await params;

        const { data: msg, error: msgError } = await supabase
            .from('messages')
            .select('*')
            .eq('id', id)
            .single();

        const { data: settings } = await supabase.from('settings').select('*').single();

        if (msgError || !msg) {
            return NextResponse.json({ error: "Message not found" }, { status: 404 });
        }

        const newDraft = await generateAiDraft({
            category: msg.category,
            body: msg.body_text,
            rulebook: settings?.rulebook || '',
            shopifyData: msg.shopify_data,
            toneExamples: settings?.signature || ''
        });

        await supabase
            .from('messages')
            .update({ ai_draft: newDraft })
            .eq('id', id);

        return NextResponse.json({ ai_draft: newDraft });
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}