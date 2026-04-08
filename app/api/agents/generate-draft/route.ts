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

    // 1. Get the message
    const { data: message } = await supabase.from('messages').select('*').eq('id', messageId).single();
    if (!message) throw new Error("Message not found");

    // 2. Get the store ID through the connection
    const { data: conn } = await supabase.from('user_connections').select('store_id').eq('id', message.connection_id).single();
    
    // 3. Get the rulebook using the store ID
    const { data: settings } = await supabase.from('settings').select('rulebook, store_name').eq('store_id', conn?.store_id).single();

    const rulebook = settings?.rulebook || "Be professional and helpful.";
    const storeName = settings?.store_name || "the store";

    // 4. Generate with Claude Sonnet 4.5
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5', 
      max_tokens: 1000,
      messages: [{ 
        role: 'user', 
        content: `Agent for: ${storeName}\nRules: ${rulebook}\nCustomer Email: ${message.body_text}\n\nDraft a professional reply:` 
      }],
    });

    const draft = response.content[0].type === 'text' ? response.content[0].text : '';

    // 5. Update DB
    await supabase.from('messages').update({ ai_draft: draft, status: 'drafted' }).eq('id', messageId);

    return NextResponse.json({ draft });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}