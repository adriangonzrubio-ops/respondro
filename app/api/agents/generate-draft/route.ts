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

    // 2. Get the store context
    const { data: conn } = await supabase.from('user_connections').select('store_id').eq('id', message.connection_id).single();
    const { data: settings } = await supabase.from('settings').select('*').eq('store_id', conn?.store_id).single();

    // 3. Generate with the correct Claude Sonnet 4.5 identifier
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929', 
      max_tokens: 1200,
      messages: [{ 
        role: 'user', 
        content: `
          You are a senior Support Lead for ${settings?.store_name || 'the store'}.
          
          RULEBOOK: ${settings?.rulebook || 'Be professional.'}
          CUSTOMER EMAIL: ${message.body_text}
          SHOPIFY DATA: ${JSON.stringify(message.shopify_data || {})}
          
          TASK: Draft a professional, branded response. No placeholders like [Name]. 
          Sign off as: "${settings?.store_name || 'Store'} Support Team".
        ` 
      }],
    });

    const rawContent = response.content[0].type === 'text' ? response.content[0].text : '';
    // Clean up any remaining quotes or bold marks
    const draft = rawContent.replace(/\*\*/g, '').replace(/^["']|["']$/g, '').trim();

    // 4. Update DB - Setting status to 'needs_review' so it stays on your board
    await supabase.from('messages').update({ 
        ai_draft: draft, 
        status: 'needs_review' 
    }).eq('id', messageId);

    return NextResponse.json({ draft });

  } catch (error: any) {
    console.error("❌ Manual Draft Failed:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}