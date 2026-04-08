import { Anthropic } from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

export async function POST(req: Request) {
  try {
    const { messageId } = await req.json();

    // 1. Fetch message and the connection details
    const { data: message, error: msgError } = await supabase
      .from('messages')
      .select('*, connection:connection_id(store_id)')
      .eq('id', messageId)
      .single();

    if (msgError || !message) throw new Error("Message/Connection link not found.");

    // 2. Fetch the store rules using the store_id we found
    const { data: settings } = await supabase
      .from('settings')
      .select('rulebook, store_name')
      .eq('store_id', message.connection.store_id)
      .single();

    const rulebook = settings?.rulebook || "Be professional and follow standard Shopify policies.";
    const storeName = settings?.store_name || "the store";

    // 3. Generate Draft with Sonnet 4.5
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1000,
      messages: [{ 
        role: 'user', 
        content: `Draft a response for ${storeName}. \nRules: ${rulebook} \nEmail: ${message.body_text}` 
      }],
    });

    const draft = response.content[0].type === 'text' ? response.content[0].text : '';

    // 4. Update the DB
    await supabase.from('messages').update({ ai_draft: draft, status: 'drafted' }).eq('id', messageId);

    return NextResponse.json({ draft });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}