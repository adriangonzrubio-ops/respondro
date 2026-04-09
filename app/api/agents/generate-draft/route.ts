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
    const { data: message } = await supabase
      .from('messages')
      .select('*')
      .eq('id', messageId)
      .single();

    if (!message) throw new Error('Message not found');

    // 2. Get settings — try message.store_id first, then fall back to first store
    let settings = null;
    let storeName = 'Our Store';

    if (message.store_id) {
      const { data: s } = await supabase
        .from('settings')
        .select('*')
        .eq('store_id', message.store_id)
        .single();
      settings = s;

      const { data: store } = await supabase
        .from('stores')
        .select('store_name')
        .eq('id', message.store_id)
        .single();
      storeName = store?.store_name || 'Our Store';
    }

    // Fallback: if still no settings, grab the first store's settings
    if (!settings) {
      console.warn('⚠️ No store_id on message, falling back to first store');
      const { data: firstStore } = await supabase
        .from('stores')
        .select('*')
        .limit(1)
        .single();

      if (firstStore) {
        storeName = firstStore.store_name || 'Our Store';
        const { data: s } = await supabase
          .from('settings')
          .select('*')
          .eq('store_id', firstStore.id)
          .single();
        settings = s;

        // Also patch the message with the correct store_id
        await supabase
          .from('messages')
          .update({ store_id: firstStore.id })
          .eq('id', messageId);
      }
    }

    const rulebook = settings?.rulebook || 'Be helpful, professional and empathetic.';

    // 3. Generate with Claude
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1200,
      messages: [{
        role: 'user',
        content: `You are a senior Support Lead for ${storeName}.

RULEBOOK: ${rulebook}

CUSTOMER EMAIL: ${message.body_text}

SHOPIFY DATA: ${JSON.stringify(message.shopify_data || {})}

TASK: Write a professional, warm, complete email reply. 
- Address the customer by first name if available
- Be specific using the Shopify data if relevant  
- Follow the rulebook exactly
- Sign off as: "${storeName} Support Team"
- Output ONLY the email body, no subject line, no placeholders like [Name]`
      }],
    });

    const rawContent = response.content[0].type === 'text' ? response.content[0].text : '';
    const draft = rawContent.replace(/^["']|["']$/g, '').trim();

    // 4. Save draft to DB
    await supabase
      .from('messages')
      .update({ ai_draft: draft, status: 'needs_review' })
      .eq('id', messageId);

    return NextResponse.json({ draft });

  } catch (error: any) {
    console.error('❌ Draft Failed:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}