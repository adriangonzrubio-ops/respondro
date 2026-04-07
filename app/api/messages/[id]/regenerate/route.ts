import { NextResponse } from 'next/server';
import { supabase } from '../../../../../lib/supabase';
import { generateAiDraft } from '../../../../../lib/ai-generator';

// The "Promise" in the type below is what satisfies the new Next.js rules
export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    // 1. Get the Rulebook and Signature from the frontend request
    const { rulebook, signature } = await req.json();
    const { id } = params;

    // 2. Fetch the specific message from Supabase to get the context
    const { data: message, error } = await supabase
      .from('messages')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !message) throw new Error("Message not found");

    // 3. This is the critical part: Pass the rulebook into your AI prompt
// 1. Prepare the rules (combining the rulebook and signature for the AI)
    const combinedRules = `
      Follow these specific instructions: ${rulebook || 'Be professional.'}
      Always end the response with this exact signature: ${signature || 'Best regards.'}
    `;

    // 2. Call the AI with the expected Object structure
    const draft = await generateAiDraft({
      category: message.category || 'General',
      body: message.body_text || '',
      rulebook: combinedRules,
      shopifyData: message.shopify_data || {}
    });

    return Response.json({ draft });

  } catch (err) {
    console.error("Backend Regeneration Error:", err);
    return Response.json({ error: "Failed to generate draft" }, { status: 500 });
  }
}