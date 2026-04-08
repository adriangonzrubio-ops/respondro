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
    console.log("🚀 Starting draft generation for ID:", messageId);

    // 1. Fetch the message
    const { data: message, error: msgError } = await supabase
      .from('messages')
      .select('*')
      .eq('id', messageId)
      .single();

    if (msgError || !message) throw new Error(`Message not found: ${msgError?.message}`);

    // 2. Fetch the connection to get store_id
    const { data: conn, error: connError } = await supabase
      .from('user_connections')
      .select('store_id')
      .eq('id', message.connection_id)
      .single();

    if (connError || !conn) throw new Error("Connection/Store link not found.");

    // 3. Fetch the Store Settings (Rulebook)
    const { data: settings } = await supabase
      .from('settings')
      .select('rulebook, store_name')
      .eq('store_id', conn.store_id)
      .single();

    const rulebook = settings?.rulebook || "Be professional and helpful.";
    const storeName = settings?.store_name || "the store";

    // 4. Generate the draft using Claude Sonnet 4.5
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5', 
      max_tokens: 1000,
      messages: [{ 
        role: 'user', 
        content: `You are a CS agent for ${storeName}. \n\nRULES: ${rulebook} \n\nCUSTOMER EMAIL: ${message.body_text} \n\nDraft a reply:` 
      }],
    });

    const draft = response.content[0].type === 'text' ? response.content[0].text : '';

    // 5. Save back to DB
    const { error: updateError } = await supabase
      .from('messages')
      .update({ ai_draft: draft, status: 'drafted' })
      .eq('id', messageId);

    if (updateError) throw new Error("Failed to update database with draft.");

    return NextResponse.json({ draft });
  } catch (error: any) {
    console.error("❌ Drafting API Crash:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}