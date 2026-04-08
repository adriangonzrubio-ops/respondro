import { Anthropic } from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: Request) {
  try {
    const { messageId } = await req.json();

    // 1. Fetch the message to get the connection_id
    const { data: message, error: msgError } = await supabase
      .from('messages')
      .select('*')
      .eq('id', messageId)
      .single();

    if (msgError || !message) throw new Error("Message not found in database.");

    // 2. Fetch the connection to get the store_id
    const { data: conn, error: connError } = await supabase
      .from('user_connections')
      .select('store_id')
      .eq('id', message.connection_id)
      .single();

    if (connError || !conn) throw new Error("Connection/Store link not found.");

    // 3. Fetch the Rulebook from settings
    const { data: settings, error: setError } = await supabase
      .from('settings')
      .select('rulebook, store_name')
      .eq('store_id', conn.store_id)
      .single();

    const rulebook = settings?.rulebook || "Be professional and helpful.";
    const storeName = settings?.store_name || "the store";

    // 4. Generate the draft using Claude Sonnet 4.5
    const prompt = `
      You are the lead CS agent for ${storeName}.
      
      CUSTOMER EMAIL:
      Subject: ${message.subject}
      Body: ${message.body_text}

      STORE RULES & POLICIES:
      ${rulebook}

      TASK:
      Write a professional, empathetic response. 
      - Use the rules provided.
      - If it's a refund/cancellation, say a manager will review it.
      - Sign off as "The ${storeName} Team". No placeholders like [Name].
    `;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5', // Locked in for Respondro
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    });

    const draft = response.content[0].type === 'text' ? response.content[0].text : '';

    // 5. Update the message in Supabase
    await supabase
      .from('messages')
      .update({ ai_draft: draft, status: 'drafted' })
      .eq('id', messageId);

    return NextResponse.json({ draft });
  } catch (error: any) {
    console.error("Drafting Error:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}