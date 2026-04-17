import { Anthropic } from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function POST(req: Request) {
  try {
    const { messageId } = await req.json();

    const { data: message } = await supabaseAdmin
      .from('messages')
      .select('*')
      .eq('id', messageId)
      .single();

    if (!message) throw new Error('Message not found');

    let storeId = message.store_id;
    let storeName = 'Our Store';
    let settings: any = null;

    if (storeId) {
      const { data: s } = await supabaseAdmin.from('settings').select('*').eq('store_id', storeId).single();
      settings = s;

      const { data: store } = await supabaseAdmin.from('stores').select('store_name').eq('id', storeId).single();
      storeName = store?.store_name || settings?.store_name || 'Our Store';
    }

    if (!settings && !storeId) {
      const { data: firstStore } = await supabaseAdmin.from('stores').select('*').limit(1).single();
      if (firstStore) {
        storeId = firstStore.id;
        storeName = firstStore.store_name || 'Our Store';
        const { data: s } = await supabaseAdmin.from('settings').select('*').eq('store_id', firstStore.id).single();
        settings = s;
        if (settings?.store_name) storeName = settings.store_name;

        await supabaseAdmin.from('messages').update({ store_id: firstStore.id }).eq('id', messageId);
      }
    }

    let rulebook = settings?.rulebook || 'Be helpful, professional and empathetic.';

    if (storeId) {
      const { data: agents } = await supabaseAdmin.from('support_agents').select('agent_type, rulebook, is_enabled').eq('store_id', storeId);
      if (agents && agents.length > 0) {
        const agentRules = agents.filter(a => a.is_enabled && a.rulebook).map(a => `[${a.agent_type.toUpperCase()} AGENT]:\n${a.rulebook}`).join('\n\n');
        if (agentRules) rulebook += '\n\n' + agentRules;
      }
      const { data: policies } = await supabaseAdmin.from('store_policies').select('policy_type, policy_content').eq('store_id', storeId);
      if (policies && policies.length > 0) {
        const policyText = policies.filter(p => p.policy_content).map(p => `[${p.policy_type.replace(/_/g, ' ').toUpperCase()}]:\n${p.policy_content.substring(0, 3000)}`).join('\n\n');
        if (policyText) rulebook += '\n\nSTORE POLICIES:\n' + policyText;
      }
    }

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1200,
      messages: [{
        role: 'user',
        content: `You are a support agent for ${storeName}. Write a reply to this customer email.

RULEBOOK: ${rulebook}

CUSTOMER EMAIL: ${message.body_text}

SHOPIFY DATA: ${JSON.stringify(message.shopify_data || {})}

CRITICAL RULES:
1. Output ONLY the email text you would send to the customer
2. NEVER include your thinking, analysis, situation assessment, or internal reasoning
3. NEVER start with "Looking at", "Based on", "Let me check", "I can see that"
4. Start directly with "Hi [first name]," then address their question
5. Be specific using Shopify data (order numbers, tracking, products)
6. Follow the rulebook exactly
7. Write in plain text, no markdown
8. Short paragraphs, friendly human tone
9. DO NOT write any sign-off or signature
10. No placeholders like [Name] — use real data or omit
11. Match the customer's language if not English

Output ONLY the email body text. Nothing else.`
      }],
    });

    const rawContent = response.content[0].type === 'text' ? response.content[0].text : '';
    let draft = rawContent.replace(/^["']|["']$/g, '').trim();

    draft = draft.replace(/\*\*/g, '').replace(/__/g, '').replace(/^#+\s/gm, '').replace(/^[-*]\s/gm, '');

    let lines = draft.split('\n');
    let emailStart = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.match(/^(Hi|Hello|Hey|Dear|Good morning|Good afternoon|Good evening|Thank you for|Thanks for)/i)) {
        emailStart = i;
        break;
      }
      if (line.match(/^(Looking at|Based on|Let me|I can see|The order|The customer|This qualifies|This is a|No prior|Days since|That's \d|Order #?\d|---)/i) || line === '') {
        emailStart = i + 1;
      }
    }
    if (emailStart > 0 && emailStart < lines.length) {
      draft = lines.slice(emailStart).join('\n').trim();
    }

    const signature = settings?.signature || '';
    if (signature) {
      draft = draft + '\n\n' + signature;
    }

    await supabaseAdmin.from('messages').update({ ai_draft: draft, status: 'needs_review' }).eq('id', messageId);

    return NextResponse.json({ draft });

  } catch (error: any) {
    console.error('❌ Draft Failed:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}