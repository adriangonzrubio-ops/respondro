import { Anthropic } from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// Initialize AI and Database
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY! 
);

export async function POST(req: Request) {
  try {
    const { messageId } = await req.json();

    // 1. Fetch the message and the store's rules
    const { data: message, error: msgError } = await supabase
      .from('messages')
      .select('*, store:store_id(rulebook, store_name)')
      .eq('id', messageId)
      .single();

    if (msgError || !message) throw new Error("Message not found");

    const prompt = `
      You are the lead CS agent for ${message.store.store_name}.
      
      CUSTOMER EMAIL:
      Subject: ${message.subject}
      Body: ${message.body_text}

      STORE RULES & POLICIES:
      ${message.store.rulebook}

      TASK:
      Write a professional, empathetic, and concise response. 
      - If the answer is in the rules, provide it clearly.
      - If it's a cancellation or refund, acknowledge it and say a manager will finalize it.
      - Do not use placeholders like [Your Name]. Sign off as "The ${message.store.store_name} Team".
    `;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5', // Locked in for Respondro
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    });

    const draft = response.content[0].type === 'text' ? response.content[0].text : '';

    // 3. Save the draft back to Supabase
    await supabase
      .from('messages')
      .update({ ai_draft: draft, status: 'drafted' })
      .eq('id', messageId);

    return NextResponse.json({ draft });
  } catch (error: any) {
    console.error("Drafting Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}