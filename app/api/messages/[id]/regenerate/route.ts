import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { generateAiDraft } from '../../../../../lib/ai-generator';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { id } = await params;
        
        // 1. Get the merchant's settings from the request (SaaS Dynamic)
        const { rulebook, signature } = await req.json();

        // 2. Fetch the message context from Supabase
        const { data: message, error } = await supabase
            .from('messages')
            .select('*')
            .eq('id', id)
            .single();

        if (error || !message) {
            return NextResponse.json({ error: "Message context not found" }, { status: 404 });
        }

        // 3. SaaS "Data Healing"
        // If body_text is missing in DB, we can't draft. 
        // A pro app would log this for the merchant.
        if (!message.body_text) {
            return NextResponse.json({ error: "Cannot generate draft: Original email content is missing." }, { status: 400 });
        }

        // 4. Construct a high-priority prompt for the AI
        // We wrap the rulebook and signature clearly so the AI can't ignore them
        const merchantContext = `
            # BRAND RULEBOOK
            ${rulebook || 'Be helpful, professional, and concise.'}

            # REQUIRED SIGNATURE
            ${signature || 'Best regards, Customer Support'}
        `;

        // 5. Generate the Draft using the AI Service
        // We pass the full message object to ensure it has Shopify order data if available
        const draft = await generateAiDraft({
            category: message.category || 'General Inquiry',
            body: message.body_text,
            rulebook: merchantContext,
            shopifyData: message.shopify_data || {} // This is the gold for SaaS
        });

        if (!draft) {
            throw new Error("AI Service returned an empty response");
        }

        // 6. Final SaaS Step: Save the draft back to the DB 
        // This ensures if the user refreshes, the work isn't lost.
        await supabase
            .from('messages')
            .update({ ai_draft: draft })
            .eq('id', id);

        return NextResponse.json({ draft });

    } catch (err: any) {
        console.error("🚀 SaaS Regeneration Crash:", err.message);
        return NextResponse.json({ 
            error: "Drafting failed. Please check your Shopify connection or AI credits.",
            details: err.message 
        }, { status: 500 });
    }
}